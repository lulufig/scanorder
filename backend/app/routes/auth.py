from fastapi import APIRouter, HTTPException, status, Depends
from app.schemas.auth import UserRegister, UserLogin, Token
from app.database import get_db_connection, close_db_connection
from app.utils.security import hash_password, verify_password, create_access_token
from app.utils.dependencies import get_current_user, require_role

router = APIRouter(
    prefix="/auth",
    tags=["Autenticación"]
)

@router.post("/register", status_code=status.HTTP_201_CREATED)
def register_user(user: UserRegister):
    """
    Registra un nuevo usuario en el sistema.
    """
    connection = get_db_connection()
    
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    
    try:
        cursor = connection.cursor(dictionary=True)
        
        # Verificar si el email ya existe
        cursor.execute("SELECT id_usuario FROM usuarios WHERE email = %s", (user.email,))
        existing_user = cursor.fetchone()
        
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El email ya está registrado"
            )
        
        # Hashear la contraseña
        hashed_password = hash_password(user.password)
        
        # Insertar usuario
        query = """
            INSERT INTO usuarios (nombre, email, password_hash, rol)
            VALUES (%s, %s, %s, %s)
        """
        cursor.execute(query, (user.nombre, user.email, hashed_password, user.rol))
        connection.commit()
        
        return {
            "message": "Usuario registrado exitosamente",
            "email": user.email
        }
        
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al registrar usuario: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)

@router.post("/login", response_model=Token)
def login_user(credentials: UserLogin):
    """
    Inicia sesión y retorna un token JWT.
    """
    connection = get_db_connection()
    
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    
    try:
        cursor = connection.cursor(dictionary=True)
        
        # Buscar usuario por email
        cursor.execute(
            "SELECT * FROM usuarios WHERE email = %s AND activo = TRUE",
            (credentials.email,)
        )
        user = cursor.fetchone()
        
        # Verificar que el usuario existe
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciales inválidas"
            )
        
        # Verificar contraseña
        if not verify_password(credentials.password, user["password_hash"]):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciales inválidas"
            )
        
        # Crear token JWT
        token_data = {
            "user_id": user["id_usuario"],
            "email": user["email"],
            "rol": user["rol"]
        }
        
        access_token = create_access_token(data=token_data)
        
        # Preparar respuesta
        user_data = {
            "id_usuario": user["id_usuario"],
            "nombre": user["nombre"],
            "email": user["email"],
            "rol": user["rol"],
            "activo": user["activo"]
        }
        
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": user_data
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error en login: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/me")
def get_current_user_info(current_user: dict = Depends(get_current_user)):
    """
    Endpoint protegido - retorna info del usuario actual.
    Requiere token válido.
    """
    return {
        "message": "Acceso autorizado",
        "user": current_user
    }

@router.get("/admin-only")
def admin_only_endpoint(current_user: dict = Depends(require_role("admin"))):
    """
    Endpoint solo para administradores.
    """
    return {
        "message": "Acceso autorizado - Solo admins",
        "user": current_user
    }