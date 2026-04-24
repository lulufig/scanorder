from pydantic import BaseModel, EmailStr
from typing import Optional

class UserRegister(BaseModel):
    """Schema para registrar un usuario nuevo"""
    nombre: str
    email: EmailStr
    password: str
    rol: str = "cocina"  # por defecto cocina, puede ser "admin"

class UserLogin(BaseModel):
    """Schema para login"""
    email: EmailStr
    password: str

class Token(BaseModel):
    """Schema para el token JWT"""
    access_token: str
    token_type: str
    user: dict

class UserResponse(BaseModel):
    """Schema para la respuesta de usuario (sin password)"""
    id_usuario: int
    nombre: str
    email: str
    rol: str
    activo: bool