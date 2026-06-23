import logging
from fastapi import APIRouter, HTTPException, Depends, Query, status
from pydantic import BaseModel, Field
from typing import List, Optional

from app.database import get_db_connection, close_db_connection
from app.utils.dependencies import require_role
from app.services.inventory_service import (
    ajustar_stock_manual,
    incrementar_stock,
    obtener_productos_bajo_minimo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inventario", tags=["Inventario"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class AjusteStockBody(BaseModel):
    stock_actual: int = Field(..., ge=0, description="Nuevo valor absoluto de stock")
    stock_minimo: int = Field(..., ge=0, description="Nuevo umbral de alerta")
    motivo: Optional[str] = Field(None, max_length=500)


class EntradaStockBody(BaseModel):
    cantidad: int = Field(..., gt=0, description="Unidades a agregar")
    motivo: Optional[str] = Field(None, max_length=500)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _estado_stock(stock_actual: int, stock_minimo: int) -> str:
    if stock_actual == 0:
        return "AGOTADO"
    if stock_actual < stock_minimo:
        return "BAJO"
    return "OK"


def _inventario_columns_exist(cursor) -> bool:
    cursor.execute("SHOW COLUMNS FROM productos LIKE 'stock_actual'")
    return cursor.fetchone() is not None


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/", summary="Listado completo de inventario")
def listar_inventario(
    estado: Optional[str] = Query(None, description="Filtrar por estado: OK, BAJO, AGOTADO"),
    current_user: dict = Depends(require_role("admin")),
):
    """
    Lista todos los productos con su stock actual, mínimo y estado calculado.
    Soporta ?estado=bajo para filtrar solo los alertas.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a la base de datos")
    try:
        cursor = connection.cursor(dictionary=True)
        if not _inventario_columns_exist(cursor):
            raise HTTPException(
                status_code=503,
                detail="Módulo de inventario no configurado. Aplicar migración 010_inventory.sql.",
            )

        cursor.execute(
            """SELECT p.id_producto, p.nombre, p.disponible,
                      p.stock_actual, p.stock_minimo,
                      c.nombre AS categoria
               FROM productos p
               LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
               ORDER BY c.nombre, p.nombre"""
        )
        productos = cursor.fetchall()

        resultado = []
        for p in productos:
            estado_calc = _estado_stock(p["stock_actual"], p["stock_minimo"])
            if estado and estado.upper() != estado_calc:
                continue
            resultado.append({
                **p,
                "estado": estado_calc,
            })
        return resultado
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/bajo-minimo", summary="Productos con stock por debajo del mínimo")
def listar_bajo_minimo(
    current_user: dict = Depends(require_role("admin")),
):
    """Lista productos donde stock_actual < stock_minimo."""
    items = obtener_productos_bajo_minimo()
    return [
        {**item, "estado": _estado_stock(item["stock_actual"], item["stock_minimo"])}
        for item in items
    ]


@router.put("/{id_producto}", summary="Ajustar stock y mínimo de un producto")
def ajustar_stock(
    id_producto: int,
    body: AjusteStockBody,
    current_user: dict = Depends(require_role("admin")),
):
    """Ajuste manual de stock_actual y stock_minimo. Registra movimiento tipo 'ajuste'."""
    return ajustar_stock_manual(
        id_producto,
        body.stock_actual,
        body.stock_minimo,
        body.motivo or "Ajuste manual de admin",
        current_user["user_id"],
    )


@router.post("/{id_producto}/entrada", summary="Registrar entrada de stock")
def entrada_stock(
    id_producto: int,
    body: EntradaStockBody,
    current_user: dict = Depends(require_role("admin")),
):
    """Registra una entrada de stock (compra, devolución, reposición)."""
    return incrementar_stock(
        id_producto,
        body.cantidad,
        body.motivo or "Entrada de stock",
        current_user["user_id"],
    )


# ── Router separado para movimientos ─────────────────────────────────────────

movimientos_router = APIRouter(prefix="/movimientos-stock", tags=["Inventario"])


@movimientos_router.get("/", summary="Historial de movimientos de stock")
def listar_movimientos(
    producto_id: Optional[int] = Query(None),
    tipo: Optional[str] = Query(None, description="entrada | salida | ajuste"),
    desde: Optional[str] = Query(None, description="YYYY-MM-DD"),
    hasta: Optional[str] = Query(None, description="YYYY-MM-DD"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(require_role("admin")),
):
    """Historial paginado de movimientos de stock, ordenado por fecha desc."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status_code=500, detail="Error de conexión a la base de datos")
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute("SHOW TABLES LIKE 'movimientos_stock'")
        if cursor.fetchone() is None:
            return {"total": 0, "page": page, "limit": limit, "items": []}

        conditions = []
        params: list = []

        if producto_id:
            conditions.append("m.id_producto = %s")
            params.append(producto_id)
        if tipo and tipo in ("entrada", "salida", "ajuste"):
            conditions.append("m.tipo = %s")
            params.append(tipo)
        if desde:
            conditions.append("DATE(m.created_at) >= %s")
            params.append(desde)
        if hasta:
            conditions.append("DATE(m.created_at) <= %s")
            params.append(hasta)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        cursor.execute(
            f"SELECT COUNT(*) AS total FROM movimientos_stock m {where}", params
        )
        total = cursor.fetchone()["total"]

        offset = (page - 1) * limit
        cursor.execute(
            f"""SELECT m.id, m.id_producto, p.nombre AS producto_nombre,
                       m.cantidad, m.tipo, m.id_pedido,
                       m.motivo, m.created_at,
                       u.nombre AS created_by_nombre
                FROM movimientos_stock m
                LEFT JOIN productos p ON p.id_producto = m.id_producto
                LEFT JOIN usuarios u ON u.id_usuario = m.created_by
                {where}
                ORDER BY m.created_at DESC
                LIMIT %s OFFSET %s""",
            [*params, limit, offset],
        )
        items = cursor.fetchall()

        return {"total": total, "page": page, "limit": limit, "items": items}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        cursor.close()
        close_db_connection(connection)
