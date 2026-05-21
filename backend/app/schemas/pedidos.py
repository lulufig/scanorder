from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from datetime import datetime


class DetallePedidoCreate(BaseModel):
    """Un ítem dentro de un pedido nuevo."""
    id_producto: int
    cantidad: int = Field(ge=1, description="Debe ser al menos 1")


class PedidoCreate(BaseModel):
    """Schema para crear un pedido completo."""
    id_mesa: int
    productos: List[DetallePedidoCreate]
    observaciones: Optional[str] = None
    qr_token: Optional[str] = None
    client_id: Optional[str] = None


class ServicioMesaCreate(BaseModel):
    """Solicitud de atencion desde una mesa."""
    id_mesa: int
    tipo: Literal["mozo", "cuenta"]
    qr_token: Optional[str] = None


class EstadoUpdate(BaseModel):
    """Schema para cambiar el estado de un pedido."""
    estado: Literal["confirmado", "en_preparacion", "listo", "entregado"]


class DetallePedidoResponse(BaseModel):
    """Línea de detalle de un pedido."""
    id_producto: int
    nombre: str
    cantidad: int
    subtotal: float


class PedidoResponse(BaseModel):
    """Respuesta básica de un pedido (para listados)."""
    id_pedido: int
    id_mesa: int
    estado: str
    total: float
    fecha: datetime
    observaciones: Optional[str] = None


class PedidoCompletoResponse(PedidoResponse):
    """Respuesta completa de un pedido con su detalle de productos."""
    detalle: List[DetallePedidoResponse]
