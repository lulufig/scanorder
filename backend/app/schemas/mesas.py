from pydantic import BaseModel
from typing import Optional


class MesaCreate(BaseModel):
    """Schema para crear una nueva mesa."""
    numero: int


class MesaResponse(BaseModel):
    """Schema de respuesta para una mesa."""
    id_mesa: int
    numero: int
    qr_url: Optional[str]