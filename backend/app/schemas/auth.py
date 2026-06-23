from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional

ROLES_VALIDOS = {"admin", "mozo"}


class UserRegister(BaseModel):
    nombre: str
    email: EmailStr
    password: str
    rol: str = "mozo"

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
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str
    user: dict


class UserResponse(BaseModel):
    id_usuario: int
    nombre: str
    email: str
    rol: str
    activo: bool
    debe_cambiar_password: Optional[bool] = False
