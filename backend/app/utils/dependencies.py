from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.security import decode_access_token
from app.database import get_db_connection, close_db_connection

security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """
    Dependencia que valida el token JWT y retorna el usuario actual.
    """
    token = credentials.credentials
    
    payload = decode_access_token(token)
    
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido o expirado",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Obtener datos del usuario desde el payload
    user_id = payload.get("user_id")
    email = payload.get("email")
    rol = payload.get("rol")
    
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido",
        )
    
    return {
        "user_id": user_id,
        "email": email,
        "rol": rol
    }

def require_role(required_role: str):
    """
    Dependencia que valida que el usuario tenga un rol específico.
    """
    def role_checker(current_user: dict = Depends(get_current_user)):
        if current_user["rol"] != required_role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Se requiere rol de {required_role}"
            )
        return current_user
    
    return role_checker