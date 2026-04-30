from pydantic import BaseModel
from typing import Optional


class ProductoCreate(BaseModel):
    """Schema para crear un nuevo producto."""
    nombre: str
    descripcion: Optional[str] = None
    precio: float
    id_categoria: int
    imagen_url: Optional[str] = None
    disponible: bool = True


class ProductoUpdate(BaseModel):
    """Schema para actualizar un producto (todos los campos son opcionales)."""
    nombre: Optional[str] = None
    descripcion: Optional[str] = None
    precio: Optional[float] = None
    id_categoria: Optional[int] = None
    imagen_url: Optional[str] = None
    disponible: Optional[bool] = None


class ProductoResponse(BaseModel):
    """Schema de respuesta para un producto."""
    id_producto: int
    nombre: str
    descripcion: Optional[str]
    precio: float
    id_categoria: int
    imagen_url: Optional[str]
    disponible: bool
    categoria: Optional[str] = None
