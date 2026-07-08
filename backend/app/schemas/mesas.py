from pydantic import BaseModel
from typing import Optional, List


class MesaCreate(BaseModel):
    numero: int


class MesaResponse(BaseModel):
    id_mesa: int
    numero: int
    qr_url: Optional[str]
    qr_token: Optional[str] = None


class ItemCuentaResponse(BaseModel):
    id_producto: int
    nombre: str
    cantidad: int
    precio_unitario: float
    subtotal: float
    categoria: Optional[str] = None
    subcategoria: Optional[str] = None


class PedidoCuentaResponse(BaseModel):
    id_pedido: int
    estado: str
    total: float
    fecha: str
    items: List[ItemCuentaResponse]


class CuentaMesaResponse(BaseModel):
    id_mesa: int
    numero_mesa: int
    pedidos: List[PedidoCuentaResponse]
    total_consumido: float
    tiene_pendientes: bool


class CierreMesaCreate(BaseModel):
    metodo_pago: str = "efectivo"
    monto_cobrado: float
    observaciones: Optional[str] = None


class CierreMesaResponse(BaseModel):
    id_cierre: int
    id_mesa: int
    numero_mesa: int
    metodo_pago: str
    total_consumido: float
    monto_cobrado: float
    vuelto: float
    pedidos_incluidos: int
    created_at: str
    entrega_pendiente: bool = False
