import logging
from fastapi import HTTPException, status
from app.database import get_db_connection, close_db_connection

logger = logging.getLogger(__name__)


class InsufficientStockError(Exception):
    """Lanzada por validar_stock_batch cuando uno o más productos no tienen stock."""
    def __init__(self, faltantes: list):
        self.faltantes = faltantes
        super().__init__(f"Stock insuficiente para {len(faltantes)} producto(s)")


# ── helpers de detección de columna (graceful degradation) ──────────────────

def _inventario_activo(cursor) -> bool:
    """True si la migración 010 ya fue aplicada (columna stock_actual existe)."""
    cursor.execute("SHOW COLUMNS FROM productos LIKE 'stock_actual'")
    return cursor.fetchone() is not None


def _controla_stock_activo(cursor) -> bool:
    """True si la migración 013 ya fue aplicada (columna controla_stock existe).
    Si existe, solo los productos con controla_stock = TRUE participan del control
    de stock (validación al crear pedido, descuento al entregar)."""
    cursor.execute("SHOW COLUMNS FROM productos LIKE 'controla_stock'")
    return cursor.fetchone() is not None


def _movimientos_tabla_existe(cursor) -> bool:
    cursor.execute("SHOW TABLES LIKE 'movimientos_stock'")
    return cursor.fetchone() is not None


# ── operaciones de solo lectura (toman cursor del caller) ───────────────────

def validar_stock_batch(cursor, items: list) -> None:
    """
    Valida disponibilidad de stock para todos los items en UNA sola query (IN).
    items: [{"id_producto": int, "cantidad": int}]
    Si algún producto no tiene stock suficiente lanza InsufficientStockError
    con la lista completa de faltantes.
    Operación de solo lectura — no modifica la DB.
    Si la migración 010 no fue aplicada, degrada en silencio (no valida).
    """
    if not items:
        return
    if not _inventario_activo(cursor):
        return

    # Con la migración 013, solo los productos marcados controla_stock = TRUE
    # entran en la validación. Los demás no vuelven en el SELECT → se saltan
    # con la misma lógica de "producto sin fila" que ya existía.
    filtro_controla = " AND controla_stock = TRUE" if _controla_stock_activo(cursor) else ""

    ids = [item["id_producto"] for item in items]
    placeholders = ",".join(["%s"] * len(ids))
    cursor.execute(
        f"SELECT id_producto, nombre, stock_actual FROM productos "
        f"WHERE id_producto IN ({placeholders}){filtro_controla}",
        ids,
    )
    stock_map = {r["id_producto"]: r for r in cursor.fetchall()}

    faltantes = []
    for item in items:
        pid = item["id_producto"]
        cantidad = item["cantidad"]
        row = stock_map.get(pid)
        if row is not None and row["stock_actual"] < cantidad:
            faltantes.append({
                "id": pid,
                "nombre": row["nombre"],
                "disponible": row["stock_actual"],
                "solicitado": cantidad,
            })

    if faltantes:
        raise InsufficientStockError(faltantes)


# ── operaciones de escritura que participan en la transacción del caller ────

def descontar_stock_pedido(cursor, items: list, id_pedido: int, id_usuario: int) -> None:
    """
    Descuenta stock para todos los items de un pedido.
    DEBE llamarse dentro de una transacción activa (el caller hace commit/rollback).
    Usa SELECT ... FOR UPDATE para prevenir race conditions.
    Si stock quedaría negativo: log CRITICAL + HTTPException 500 (el caller hace rollback).
    Si la migración 010 no fue aplicada, degrada en silencio.
    """
    if not _inventario_activo(cursor):
        return
    if not _movimientos_tabla_existe(cursor):
        return

    # Solo se descuenta a los productos con seguimiento activo (migración 013).
    filtro_controla = " AND controla_stock = TRUE" if _controla_stock_activo(cursor) else ""

    for item in items:
        pid = item["id_producto"]
        cantidad = item["cantidad"]

        cursor.execute(
            f"SELECT stock_actual FROM productos WHERE id_producto = %s{filtro_controla} FOR UPDATE",
            (pid,),
        )
        row = cursor.fetchone()
        if row is None:
            continue

        nuevo_stock = row["stock_actual"] - cantidad
        if nuevo_stock < 0:
            logger.critical(
                "stock_negativo_detectado producto=%s stock=%s solicitado=%s pedido=%s",
                pid, row["stock_actual"], cantidad, id_pedido,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error de stock al entregar: producto {pid} quedaría en negativo",
            )

        cursor.execute(
            "UPDATE productos SET stock_actual = %s WHERE id_producto = %s",
            (nuevo_stock, pid),
        )
        cursor.execute(
            """INSERT INTO movimientos_stock
               (id_producto, cantidad, tipo, id_pedido, motivo, created_by)
               VALUES (%s, %s, 'salida', %s, 'Entrega de pedido', %s)""",
            (pid, cantidad, id_pedido, id_usuario),
        )


# ── operaciones autónomas (gestionan su propia transacción) ─────────────────

def incrementar_stock(id_producto: int, cantidad: int, motivo: str, id_usuario: int) -> dict:
    """Entrada de stock. Crea su propia transacción."""
    if cantidad <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cantidad debe ser un entero positivo",
        )
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error de conexión a la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_producto, nombre, stock_actual FROM productos "
            "WHERE id_producto = %s FOR UPDATE",
            (id_producto,),
        )
        producto = cursor.fetchone()
        if not producto:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado")

        nuevo_stock = producto["stock_actual"] + cantidad
        cursor.execute(
            "UPDATE productos SET stock_actual = %s WHERE id_producto = %s",
            (nuevo_stock, id_producto),
        )
        cursor.execute(
            """INSERT INTO movimientos_stock
               (id_producto, cantidad, tipo, id_pedido, motivo, created_by)
               VALUES (%s, %s, 'entrada', NULL, %s, %s)""",
            (id_producto, cantidad, motivo or "Entrada manual", id_usuario),
        )
        connection.commit()
        return {
            "id_producto": id_producto,
            "stock_actual": nuevo_stock,
            "tipo": "entrada",
            "cantidad": cantidad,
        }
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    finally:
        cursor.close()
        close_db_connection(connection)


def ajustar_stock_manual(
    id_producto: int,
    nuevo_stock: int,
    nuevo_minimo: int,
    motivo: str,
    id_usuario: int,
) -> dict:
    """Ajuste directo a stock_actual y stock_minimo. Registra movimiento 'ajuste'."""
    if nuevo_stock < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="stock_actual no puede ser negativo",
        )
    if nuevo_minimo < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="stock_minimo no puede ser negativo",
        )
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error de conexión a la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_producto, nombre, stock_actual, stock_minimo "
            "FROM productos WHERE id_producto = %s FOR UPDATE",
            (id_producto,),
        )
        producto = cursor.fetchone()
        if not producto:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado")

        diferencia = nuevo_stock - producto["stock_actual"]
        cursor.execute(
            "UPDATE productos SET stock_actual = %s, stock_minimo = %s WHERE id_producto = %s",
            (nuevo_stock, nuevo_minimo, id_producto),
        )
        if diferencia != 0:
            cursor.execute(
                """INSERT INTO movimientos_stock
                   (id_producto, cantidad, tipo, id_pedido, motivo, created_by)
                   VALUES (%s, %s, 'ajuste', NULL, %s, %s)""",
                (id_producto, diferencia, motivo or "Ajuste manual", id_usuario),
            )
        connection.commit()
        return {
            "id_producto": id_producto,
            "nombre": producto["nombre"],
            "stock_actual": nuevo_stock,
            "stock_minimo": nuevo_minimo,
            "diferencia": diferencia,
        }
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    finally:
        cursor.close()
        close_db_connection(connection)


def obtener_productos_bajo_minimo() -> list:
    """Lista de productos donde stock_actual < stock_minimo, ordenados por déficit desc."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error de conexión a la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        if not _inventario_activo(cursor):
            return []
        filtro_controla = " AND p.controla_stock = TRUE" if _controla_stock_activo(cursor) else ""
        cursor.execute(
            f"""SELECT p.id_producto, p.nombre, p.stock_actual, p.stock_minimo,
                       c.nombre AS categoria,
                       (p.stock_minimo - p.stock_actual) AS deficit
                FROM productos p
                LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
                WHERE p.stock_actual < p.stock_minimo{filtro_controla}
                ORDER BY deficit DESC"""
        )
        return cursor.fetchall()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    finally:
        cursor.close()
        close_db_connection(connection)
