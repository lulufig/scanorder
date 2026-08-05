import logging
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr

from app.database import close_db_connection, get_db_connection
from app.schemas.auth import Token, UserLogin, UserRegister
from app.services import email_service
from app.utils.dependencies import get_current_user, require_role
from app.utils.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Autenticación"])

# ── Rate limit simple en memoria para forgot-password ─────────────────────────
# Máximo 3 intentos por email en una ventana de 1 hora.
# Se resetea al reiniciar el proceso (suficiente para este caso de uso).
_forgot_attempts: dict[str, list[float]] = defaultdict(list)
_FORGOT_MAX = 3
_FORGOT_WINDOW = 3600  # segundos


# ── Helper de detección de columna (graceful degradation) ─────────────────────
_col_cache: dict[str, bool] = {}


def usuarios_tiene_columna(cursor, columna: str) -> bool:
    key = f"usuarios.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM usuarios LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def _check_forgot_rate_limit(email: str) -> None:
    now = time.time()
    _forgot_attempts[email] = [t for t in _forgot_attempts[email] if now - t < _FORGOT_WINDOW]
    if len(_forgot_attempts[email]) >= _FORGOT_MAX:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Demasiados intentos. Intentá de nuevo en 1 hora.",
        )
    _forgot_attempts[email].append(now)


# ── POST /auth/register ────────────────────────────────────────────────────────

@router.post("/register", status_code=status.HTTP_201_CREATED)
def register_user(user: UserRegister, request: Request):
    connection = get_db_connection()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )

    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute("SELECT COUNT(*) AS total FROM usuarios")
        total_usuarios = cursor.fetchone()["total"]

        if total_usuarios == 0 and user.rol != "admin":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El primer usuario del sistema debe tener rol admin",
            )

        if total_usuarios > 0:
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Se requiere token de administrador para registrar usuarios",
                    headers={"WWW-Authenticate": "Bearer"},
                )

            token = auth_header.removeprefix("Bearer ").strip()
            payload = decode_access_token(token)
            if not payload or payload.get("rol") != "admin":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Solo un administrador puede registrar usuarios",
                )

        cursor.execute("SELECT id_usuario FROM usuarios WHERE email = %s", (user.email,))
        if cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El email ya está registrado",
            )

        hashed_password = hash_password(user.password)

        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s, %s, %s, %s)",
            (user.nombre, user.email, hashed_password, user.rol),
        )
        connection.commit()

        return {"message": "Usuario registrado exitosamente", "email": user.email}

    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al registrar usuario: {exc}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


# ── POST /auth/login ──────────────────────────────────────────────────────────

@router.post("/login", response_model=Token)
def login_user(credentials: UserLogin):
    connection = get_db_connection()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )

    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT * FROM usuarios WHERE email = %s AND activo = TRUE",
            (credentials.email,),
        )
        user = cursor.fetchone()

        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciales inválidas",
            )

        if not verify_password(credentials.password, user["password_hash"]):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciales inválidas",
            )

        token_data = {
            "user_id": user["id_usuario"],
            "email": user["email"],
            "rol": user["rol"],
        }
        access_token = create_access_token(data=token_data)

        user_data = {
            "id_usuario": user["id_usuario"],
            "nombre": user["nombre"],
            "email": user["email"],
            "rol": user["rol"],
            "activo": user["activo"],
            "debe_cambiar_password": bool(user.get("must_change_password", False)),
        }

        return {"access_token": access_token, "token_type": "bearer", "user": user_data}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error en login: {exc}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


# ── GET /auth/me ──────────────────────────────────────────────────────────────

@router.get("/me")
def get_current_user_info(current_user: dict = Depends(get_current_user)):
    """
    Retorna info del usuario actual, incluyendo debe_cambiar_password
    leído desde la DB para reflejar el estado real (no el del token).
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)
        campo_mcp = "must_change_password" if usuarios_tiene_columna(cursor, "must_change_password") else "FALSE"
        cursor.execute(
            f"""
            SELECT id_usuario, nombre, email, rol,
                   {campo_mcp} AS debe_cambiar_password, activo
              FROM usuarios WHERE id_usuario = %s
            """,
            (current_user["user_id"],),
        )
        user = cursor.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
        user["debe_cambiar_password"] = bool(user.get("debe_cambiar_password", False))
        user["activo"] = bool(user.get("activo", True))
        return {"message": "Acceso autorizado", "user": user}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)


# ── GET /auth/admin-only ──────────────────────────────────────────────────────

@router.get("/admin-only")
def admin_only_endpoint(current_user: dict = Depends(require_role("admin"))):
    return {"message": "Acceso autorizado - Solo admins", "user": current_user}


# ── POST /auth/cambiar-password ───────────────────────────────────────────────

class CambiarPasswordRequest(BaseModel):
    password_actual: str
    nueva_password: str


@router.post("/cambiar-password")
def cambiar_password(
    body: CambiarPasswordRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Cambia la contraseña del usuario autenticado.
    Valida la contraseña actual antes de actualizar.
    Limpia el flag must_change_password (primer login forzado).
    """
    if len(body.nueva_password.encode("utf-8")) > 72:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña no puede superar 72 caracteres",
        )
    if len(body.nueva_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña debe tener al menos 8 caracteres",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT password_hash FROM usuarios WHERE id_usuario = %s",
            (current_user["user_id"],),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        if not verify_password(body.password_actual, row["password_hash"]):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La contraseña actual es incorrecta",
            )

        cursor.execute(
            "UPDATE usuarios SET password_hash = %s, must_change_password = FALSE WHERE id_usuario = %s",
            (hash_password(body.nueva_password), current_user["user_id"]),
        )
        connection.commit()
        return {"message": "Contraseña actualizada correctamente"}
    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al cambiar contraseña: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)


# ── POST /auth/forgot-password ────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: EmailStr


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest):
    """
    Genera un token de reset y envía el email.
    Siempre devuelve 200 para no revelar si el email existe o no.
    Rate limit: 3 requests por email por hora (en memoria).
    """
    _check_forgot_rate_limit(body.email)

    connection = get_db_connection()
    if not connection:
        # Si no hay DB, devolvemos 200 igual (no revelamos nada al cliente)
        logger.warning("forgot-password: sin conexión a DB para %s", body.email)
        return {"message": "Si el email existe, recibirás un correo en breve."}
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_usuario, nombre FROM usuarios WHERE email = %s AND activo = TRUE",
            (body.email,),
        )
        user = cursor.fetchone()

        if user:
            token = secrets.token_urlsafe(32)
            expira_en = datetime.utcnow() + timedelta(minutes=30)
            cursor.execute(
                """
                INSERT INTO password_reset_tokens (id_usuario, token, expira_en)
                VALUES (%s, %s, %s)
                """,
                (user["id_usuario"], token, expira_en),
            )
            connection.commit()

            try:
                email_service.enviar_reset_password(body.email, user["nombre"], token)
            except Exception as exc:
                logger.warning("Error enviando reset a %s: %s", body.email, exc)

    except Exception as exc:
        logger.warning("forgot-password: error inesperado: %s", exc)
    finally:
        cursor.close()
        close_db_connection(connection)

    return {"message": "Si el email existe, recibirás un correo en breve."}


# ── POST /auth/reset-password ─────────────────────────────────────────────────

class ResetPasswordRequest(BaseModel):
    token: str
    nueva_password: str


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest):
    if len(body.nueva_password.encode("utf-8")) > 72:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña no puede superar 72 caracteres",
        )
    if len(body.nueva_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña debe tener al menos 8 caracteres",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT id, id_usuario, expira_en, usado
              FROM password_reset_tokens
             WHERE token = %s
            """,
            (body.token,),
        )
        row = cursor.fetchone()

        if not row:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Token inválido",
            )
        if row["usado"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El token ya fue utilizado",
            )
        if datetime.utcnow() > row["expira_en"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El token expiró",
            )

        cursor.execute(
            """
            UPDATE usuarios
               SET password_hash = %s, must_change_password = FALSE
             WHERE id_usuario = %s
            """,
            (hash_password(body.nueva_password), row["id_usuario"]),
        )
        # Marcar token como usado (no borrar — auditoría)
        cursor.execute(
            "UPDATE password_reset_tokens SET usado = TRUE WHERE id = %s",
            (row["id"],),
        )
        connection.commit()
        return {"message": "Contraseña actualizada correctamente"}

    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al resetear contraseña: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)
