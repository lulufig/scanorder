from typing import Optional
from fastapi import Depends, HTTPException, status, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.security import decode_access_token

security = HTTPBearer()
security_optional = HTTPBearer(auto_error=False)

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

def get_current_user_optional(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security_optional),
) -> Optional[dict]:
    """Como get_current_user pero devuelve None si no hay token (en lugar de 401).
    Útil para endpoints que aceptan autenticación alternativa (ej. device_token).
    """
    if not credentials:
        return None
    payload = decode_access_token(credentials.credentials)
    if not payload or not payload.get("user_id"):
        return None
    return {
        "user_id": payload.get("user_id"),
        "email": payload.get("email"),
        "rol": payload.get("rol"),
    }


def require_role(*required_roles: str):
    """
    Dependencia que valida que el usuario tenga uno de los roles indicados.
    Acepta uno o varios roles: require_role("admin"), require_role("mozo", "admin").
    """
    roles_set = set(required_roles)

    def role_checker(current_user: dict = Depends(get_current_user)):
        if current_user["rol"] not in roles_set:
            roles_label = " o ".join(sorted(required_roles))
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Se requiere rol de {roles_label}",
            )
        return current_user

    return role_checker