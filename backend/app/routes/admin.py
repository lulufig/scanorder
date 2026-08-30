import logging
import secrets
import string
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr

from app.database import close_db_connection, get_db_connection
from app.services import email_service
from app.utils.dependencies import require_role
from app.utils.pagination import respuesta_paginada, normalizar_limit, offset as _offset
from app.utils.security import hash_password

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])

ROLES_VALIDOS = {"admin", "mozo"}

# ── Helper de detección de columna (graceful degradation) ─────────────────────
_col_cache: dict[str, bool] = {}


def usuarios_tiene_columna(cursor, columna: str) -> bool:
    key = f"usuarios.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM usuarios LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


class UsuarioCreate(BaseModel):
    nombre: str
    email: EmailStr
    rol: str = "mozo"


class UsuarioUpdate(BaseModel):
    nombre: Optional[str] = None
    email: Optional[EmailStr] = None
    rol: Optional[str] = None


def _password_temporal(length: int = 10) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _normalizar_usuario(row: dict) -> dict:
    """mysql-connector devuelve BOOLEAN como int (0/1). Castea a bool para que
    FastAPI serialice como JSON true/false en lugar de 1/0."""
    row["debe_cambiar_password"] = bool(row.get("debe_cambiar_password", False))
    row["activo"] = bool(row.get("activo", True))
    return row


# ── GET /admin/usuarios ───────────────────────────────────────────────────────

_ORDEN_USUARIOS = {
    "recientes": "created_at DESC, id_usuario DESC",
    "antiguos":  "created_at ASC, id_usuario ASC",
    "az":        "nombre ASC",
    "za":        "nombre DESC",
}


def _filtro_usuarios(cursor, q, rol, estado):
    """WHERE compartido por el COUNT y el SELECT del listado paginado."""
    tiene_mcp = usuarios_tiene_columna(cursor, "must_change_password")
    clauses, params = [], []
    if q:
        like = f"%{q.strip()}%"
        clauses.append("(nombre LIKE %s OR email LIKE %s OR CAST(id_usuario AS CHAR) LIKE %s OR rol LIKE %s)")
        params += [like, like, like, like]
    if rol:
        clauses.append("rol = %s")
        params.append(rol)
    if estado == "inactivo":
        clauses.append("activo = FALSE")
    elif estado == "activo":
        clauses.append("activo = TRUE" + (" AND (must_change_password = FALSE OR must_change_password IS NULL)" if tiene_mcp else ""))
    elif estado == "temporal" and tiene_mcp:
        clauses.append("activo = TRUE AND must_change_password = TRUE")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


@router.get("/usuarios", dependencies=[Depends(require_role("admin"))])
def listar_usuarios(
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    q: Optional[str] = Query(None, description="Busca en nombre, email, id, rol"),
    rol: Optional[str] = Query(None, description="admin | mozo"),
    estado: Optional[str] = Query(None, description="activo | inactivo | temporal"),
    orden: str = Query("recientes", description="recientes | antiguos | az | za"),
):
    """Listado de usuarios paginado (15 por página).
    Devuelve `{items, total, page, limit, pages, resumen}` — `resumen` trae los
    contadores globales (total / activos / temporales / inactivos)."""
    limit = normalizar_limit(limit)
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_mcp = usuarios_tiene_columna(cursor, "must_change_password")
        campo_mcp = "must_change_password" if tiene_mcp else "FALSE"
        where, params = _filtro_usuarios(cursor, q, rol, estado)
        order_by = _ORDEN_USUARIOS.get(orden, _ORDEN_USUARIOS["recientes"])

        cursor.execute(f"SELECT COUNT(*) AS total FROM usuarios {where}", params)
        total = cursor.fetchone()["total"]

        cursor.execute(
            f"""SELECT id_usuario, nombre, email, rol,
                       {campo_mcp} AS debe_cambiar_password,
                       activo, created_at
                FROM usuarios {where}
                ORDER BY {order_by}
                LIMIT %s OFFSET %s""",
            [*params, limit, _offset(page, limit)],
        )
        items = [_normalizar_usuario(row) for row in cursor.fetchall()]

        if tiene_mcp:
            cursor.execute(
                """SELECT COUNT(*) AS total,
                          SUM(activo = TRUE AND (must_change_password = FALSE OR must_change_password IS NULL)) AS activos,
                          SUM(activo = TRUE AND must_change_password = TRUE) AS temporales,
                          SUM(activo = FALSE) AS inactivos
                   FROM usuarios"""
            )
        else:
            cursor.execute(
                """SELECT COUNT(*) AS total,
                          SUM(activo = TRUE) AS activos,
                          0 AS temporales,
                          SUM(activo = FALSE) AS inactivos
                   FROM usuarios"""
            )
        r = cursor.fetchone()
        resumen = {
            "total": int(r["total"]),
            "activos": int(r["activos"] or 0),
            "temporales": int(r["temporales"] or 0),
            "inactivos": int(r["inactivos"] or 0),
        }

        return respuesta_paginada(items, total, page, limit, resumen=resumen)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error al listar usuarios: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)


# ── POST /admin/usuarios ──────────────────────────────────────────────────────

@router.post("/usuarios", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_role("admin"))])
def crear_usuario(body: UsuarioCreate):
    if body.rol not in ROLES_VALIDOS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Rol inválido. Debe ser uno de: {', '.join(ROLES_VALIDOS)}",
        )

    password_temporal = _password_temporal()

    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute("SELECT id_usuario FROM usuarios WHERE email = %s", (body.email,))
        if cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El email ya está registrado",
            )

        if usuarios_tiene_columna(cursor, "must_change_password"):
            cursor.execute(
                """
                INSERT INTO usuarios (nombre, email, password_hash, rol, must_change_password)
                VALUES (%s, %s, %s, %s, TRUE)
                """,
                (body.nombre, body.email, hash_password(password_temporal), body.rol),
            )
        else:
            cursor.execute(
                """
                INSERT INTO usuarios (nombre, email, password_hash, rol)
                VALUES (%s, %s, %s, %s)
                """,
                (body.nombre, body.email, hash_password(password_temporal), body.rol),
            )
        connection.commit()
        nuevo_id = cursor.lastrowid

        campo_mcp = "must_change_password" if usuarios_tiene_columna(cursor, "must_change_password") else "FALSE"
        cursor.execute(
            f"""
            SELECT id_usuario, nombre, email, rol,
                   {campo_mcp} AS debe_cambiar_password,
                   activo, created_at
              FROM usuarios WHERE id_usuario = %s
            """,
            (nuevo_id,),
        )
        usuario = _normalizar_usuario(cursor.fetchone())
    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al crear usuario: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)

    # Best-effort: un fallo de email no revierte la creación del usuario.
    try:
        email_service.enviar_bienvenida(body.email, body.nombre, password_temporal)
    except Exception as exc:
        logger.warning("Error enviando bienvenida a %s: %s", body.email, exc)

    return usuario


# ── PATCH /admin/usuarios/{id}/activo ────────────────────────────────────────

@router.patch("/usuarios/{id_usuario}/activo",
              dependencies=[Depends(require_role("admin"))])
def cambiar_estado_usuario(id_usuario: int):
    """Alterna activo/inactivo del usuario. Devuelve el nuevo valor de activo."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_usuario, activo FROM usuarios WHERE id_usuario = %s",
            (id_usuario,),
        )
        usuario = cursor.fetchone()
        if not usuario:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        nuevo_estado = not bool(usuario["activo"])
        cursor.execute(
            "UPDATE usuarios SET activo = %s WHERE id_usuario = %s",
            (nuevo_estado, id_usuario),
        )
        connection.commit()
        return {"id_usuario": id_usuario, "activo": nuevo_estado}
    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al cambiar estado: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)


# ── PUT /admin/usuarios/{id} ──────────────────────────────────────────────────

@router.put("/usuarios/{id_usuario}", dependencies=[Depends(require_role("admin"))])
def actualizar_usuario(id_usuario: int, body: UsuarioUpdate):
    """Modifica nombre/email/rol de un usuario existente. No cambia el password
    (eso tiene su propio flujo vía /auth/cambiar-password y /auth/reset-password)."""
    if body.rol is not None and body.rol not in ROLES_VALIDOS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Rol inválido. Debe ser uno de: {', '.join(ROLES_VALIDOS)}",
        )

    campos = {}
    if body.nombre is not None:
        campos["nombre"] = body.nombre
    if body.email is not None:
        campos["email"] = body.email
    if body.rol is not None:
        campos["rol"] = body.rol

    if not campos:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No se enviaron campos para actualizar",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute("SELECT id_usuario FROM usuarios WHERE id_usuario = %s", (id_usuario,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        if "email" in campos:
            cursor.execute(
                "SELECT id_usuario FROM usuarios WHERE email = %s AND id_usuario != %s",
                (campos["email"], id_usuario),
            )
            if cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="El email ya está en uso por otro usuario",
                )

        set_clause = ", ".join(f"{campo} = %s" for campo in campos)
        cursor.execute(
            f"UPDATE usuarios SET {set_clause} WHERE id_usuario = %s",
            (*campos.values(), id_usuario),
        )
        connection.commit()

        campo_mcp = "must_change_password" if usuarios_tiene_columna(cursor, "must_change_password") else "FALSE"
        cursor.execute(
            f"""
            SELECT id_usuario, nombre, email, rol,
                   {campo_mcp} AS debe_cambiar_password,
                   activo, created_at
              FROM usuarios WHERE id_usuario = %s
            """,
            (id_usuario,),
        )
        usuario = _normalizar_usuario(cursor.fetchone())
    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al actualizar usuario: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)

    return usuario


# ── POST /admin/usuarios/{id}/reenviar-bienvenida ─────────────────────────────

@router.post("/usuarios/{id_usuario}/reenviar-bienvenida",
             dependencies=[Depends(require_role("admin"))])
def reenviar_bienvenida(id_usuario: int):
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_usuario, nombre, email FROM usuarios WHERE id_usuario = %s AND activo = TRUE",
            (id_usuario,),
        )
        usuario = cursor.fetchone()
        if not usuario:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        nueva_password = _password_temporal()
        if usuarios_tiene_columna(cursor, "must_change_password"):
            cursor.execute(
                "UPDATE usuarios SET password_hash = %s, must_change_password = TRUE WHERE id_usuario = %s",
                (hash_password(nueva_password), id_usuario),
            )
        else:
            cursor.execute(
                "UPDATE usuarios SET password_hash = %s WHERE id_usuario = %s",
                (hash_password(nueva_password), id_usuario),
            )
        connection.commit()
    except HTTPException:
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise HTTPException(status_code=500, detail=f"Error al reenviar bienvenida: {exc}")
    finally:
        cursor.close()
        close_db_connection(connection)

    try:
        email_service.enviar_bienvenida(usuario["email"], usuario["nombre"], nueva_password)
    except Exception as exc:
        logger.warning("Error reenviando bienvenida a %s: %s", usuario["email"], exc)

    return {"message": "Email de bienvenida reenviado", "id_usuario": id_usuario}
