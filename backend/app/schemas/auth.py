from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional

ROLES_VALIDOS = {"admin", "cocina"}

class UserRegister(BaseModel):
    """Schema para registrar un usuario nuevo."""
    nombre: str
    email: EmailStr
    password: str
    rol: str = "cocina"

    @field_validator("password")
    @classmethod
    def validar_password(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("La contraseña no puede superar 72 caracteres")
        return value

    @field_validator("rol")
    @classmethod
    def validar_rol(cls, value: str) -> str:
        if value not in ROLES_VALIDOS:
            raise ValueError(f"Rol inválido. Debe ser uno de: {', '.join(ROLES_VALIDOS)}")
        return value

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