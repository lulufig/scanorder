"""Helpers de paginación server-side.

Contrato de respuesta compartido por los listados del panel admin
(productos, inventario, usuarios) y por `/movimientos-stock`:

    {
        "items": [...],   # la página pedida
        "total": 123,     # total de filas que matchean los filtros
        "page": 1,
        "limit": 15,
        "pages": 9        # ceil(total / limit), mínimo 1
    }
"""
import math
from typing import Any


LIMITE_DEFAULT = 10
LIMITE_MAX = 100


def normalizar_limit(limit: int) -> int:
    if limit < 1:
        return LIMITE_DEFAULT
    return min(limit, LIMITE_MAX)


def offset(page: int, limit: int) -> int:
    return max(0, (max(1, page) - 1) * limit)


def respuesta_paginada(items: list[Any], total: int, page: int, limit: int, **extra) -> dict:
    total = max(0, int(total))
    limit = normalizar_limit(limit)
    payload = {
        "items": items,
        "total": total,
        "page": max(1, page),
        "limit": limit,
        "pages": max(1, math.ceil(total / limit)) if limit else 1,
    }
    payload.update(extra)
    return payload
