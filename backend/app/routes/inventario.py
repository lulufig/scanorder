import logging
from fastapi import APIRouter, HTTPException, Depends, Query, status
from pydantic import BaseModel, Field
from typing import List, Optional

from app.database import get_db_connection, close_db_connection
from app.utils.dependencies import require_role
from app.utils.pagination import respuesta_paginada, normalizar_limit, offset as _offset
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
    if stock_actual <= 0:
        return "AGOTADO"
    if stock_minimo > 0 and stock_actual < stock_minimo:
        return "BAJO"
    return "OK"


def _inventario_columns_exist(cursor) -> bool:
    cursor.execute("SHOW COLUMNS FROM productos LIKE 'stock_actual'")
    return cursor.fetchone() is not None


def _controla_stock_existe(cursor) -> bool:
    cursor.execute("SHOW COLUMNS FROM productos LIKE 'controla_stock'")
    return cursor.fetchone() is not None


# Fragmentos SQL del estado calculado (deben espejar _estado_stock / normalizarEstado en JS)
_SQL_AGOTADO = "p.stock_actual <= 0"
_SQL_BAJO = "(p.stock_actual > 0 AND p.stock_minimo > 0 AND p.stock_actual < p.stock_minimo)"
_FILTRO_ESTADO = {
    "OK":       f"(NOT ({_SQL_AGOTADO}) AND NOT {_SQL_BAJO})",
    "BAJO":     _SQL_BAJO,
    "AGOTADO":  f"({_SQL_AGOTADO})",
    "CRITICOS": f"(({_SQL_AGOTADO}) OR {_SQL_BAJO})",
}


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/", summary="Inventario paginado")
def listar_inventario(
    page: int = Query(1, ge=1),
    limit: int = Query(15, ge=1, le=100),
    q: Optional[str] = Query(None, description="Busca por nombre de producto"),
    estado: Optional[str] = Query(None, description="OK | BAJO | AGOTADO | CRITICOS"),
    categoria: Optional[str] = Query(None, description="Nombre exacto de categoría"),
    current_user: dict = Depends(require_role("admin")),
):
    """Productos con seguimiento de stock, paginados (15 por página).
    Devuelve `{items, total, page, limit, pages, resumen, categorias}` — cada item
    trae `estado` (OK/BAJO/AGOTADO); `resumen` son los contadores globales."""
    limit = normalizar_limit(limit)
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
        tiene_flag = _controla_stock_existe(cursor)

        clauses, params = [], []
        if tiene_flag:
            clauses.append("p.controla_stock = TRUE")
        if q:
            clauses.append("p.nombre LIKE %s")
            params.append(f"%{q.strip()}%")
        if categoria:
            clauses.append("c.nombre = %s")
            params.append(categoria)
        if estado and estado.upper() in _FILTRO_ESTADO:
            clauses.append(_FILTRO_ESTADO[estado.upper()])
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        base_from = "FROM productos p LEFT JOIN categorias c ON c.id_categoria = p.id_categoria"

        cursor.execute(f"SELECT COUNT(*) AS total {base_from} {where}", params)
        total = cursor.fetchone()["total"]

        cursor.execute(
            f"""SELECT p.id_producto, p.nombre, p.disponible,
                       p.stock_actual, p.stock_minimo, c.nombre AS categoria
                {base_from} {where}
                ORDER BY c.nombre IS NULL, c.nombre, p.nombre
                LIMIT %s OFFSET %s""",
            [*params, limit, _offset(page, limit)],
        )
        items = [
            {**p, "estado": _estado_stock(p["stock_actual"], p["stock_minimo"])}
            for p in cursor.fetchall()
        ]

        # Resumen global (mismo filtro controla_stock, sin q / estado / categoría)
        base_controla = "WHERE p.controla_stock = TRUE" if tiene_flag else ""
        cursor.execute(f"""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN {_SQL_AGOTADO} THEN 1 ELSE 0 END) AS agotado,
                   SUM(CASE WHEN {_SQL_BAJO}    THEN 1 ELSE 0 END) AS bajo
            FROM productos p {base_controla}
        """)
        r = cursor.fetchone()
        agotado, bajo = int(r["agotado"] or 0), int(r["bajo"] or 0)
        resumen = {
            "total": int(r["total"]),
            "agotado": agotado,
            "bajo": bajo,
            "ok": int(r["total"]) - agotado - bajo,
            "criticos": agotado + bajo,
        }

        cats_where = "WHERE c.nombre IS NOT NULL" + (" AND p.controla_stock = TRUE" if tiene_flag else "")
        cursor.execute(
            f"SELECT DISTINCT c.nombre AS nombre FROM categorias c "
            f"JOIN productos p ON p.id_categoria = c.id_categoria {cats_where} ORDER BY c.nombre"
        )
        categorias = [row["nombre"] for row in cursor.fetchall()]

        return respuesta_paginada(items, total, page, limit, resumen=resumen, categorias=categorias)
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
