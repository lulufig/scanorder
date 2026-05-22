from pydantic import BaseModel, Field
from typing import Optional


class ProductoCreate(BaseModel):
    """Schema para crear un nuevo producto."""
    nombre: str = Field(min_length=1, max_length=150)
    descripcion: Optional[str] = None
    precio: float = Field(gt=0)
    id_categoria: Optional[int] = None
    categoria: Optional[str] = Field(default=None, min_length=1, max_length=100)
    subcategoria: Optional[str] = Field(default=None, min_length=1, max_length=100)
    imagen_url: Optional[str] = None
    disponible: bool = True


class ProductoUpdate(BaseModel):
    """Schema para actualizar un producto (todos los campos son opcionales)."""
    nombre: Optional[str] = Field(default=None, min_length=1, max_length=150)
    descripcion: Optional[str] = None
    precio: Optional[float] = Field(default=None, gt=0)
    id_categoria: Optional[int] = None
    categoria: Optional[str] = Field(default=None, min_length=1, max_length=100)
    subcategoria: Optional[str] = Field(default=None, min_length=1, max_length=100)
    imagen_url: Optional[str] = None
    disponible: Optional[bool] = None


class ProductoResponse(BaseModel):
    """Schema de respuesta para un producto."""
    id_producto: int
    nombre: str
    descripcion: Optional[str]
    precio: float
    id_categoria: int
    subcategoria: Optional[str] = None
    imagen_url: Optional[str]
    disponible: bool
    categoria: Optional[str] = None
