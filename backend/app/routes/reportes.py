import csv
import io
from datetime import date

from fastapi import APIRouter, HTTPException, Response, status, Depends, Query

from app.database import close_db_connection, get_db_connection
from app.utils.dependencies import require_role

router = APIRouter(
    prefix="/reportes",
    tags=["Reportes"]
)

ESTADOS_VENTA_SQL = "'confirmado', 'en_preparacion', 'listo', 'entregado'"
_col_cache = {}


def pedidos_tiene_columna(cursor, columna: str) -> bool:
    """Indica si la tabla pedidos tiene una columna determinada."""
    key = f"pedidos.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM pedidos LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def cierres_mesa_existe(cursor) -> bool:
    """Indica si la tabla cierres_mesa ya fue migrada. Resultado cacheado por proceso."""
    key = "table.cierres_mesa"
    if key not in _col_cache:
        cursor.execute("SHOW TABLES LIKE 'cierres_mesa'")
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def fecha_venta_sql(cursor) -> str:
    """
    Usa la fecha de confirmacion de la venta cuando existe.
    Fallback a created_at para bases viejas que todavia no tengan trazabilidad.
    """
    if pedidos_tiene_columna(cursor, "confirmado_at"):
        return "COALESCE(confirmado_at, created_at)"
    return "created_at"


@router.get("/ventas")
def reporte_ventas(
    fecha_inicio: date = Query(..., description="Fecha de inicio (YYYY-MM-DD)"),
    fecha_fin: date    = Query(..., description="Fecha de fin (YYYY-MM-DD)"),
    current_user: dict = Depends(require_role("admin"))
):
    """
    Exporta un CSV con el reporte de ventas entre las fechas indicadas.
    Incluye resumen, pedidos por estado y productos más vendidos (top 10).
    Solo administradores. El CSV usa separador ; y BOM UTF-8 para Excel (es-AR).
    """
    if fecha_inicio > fecha_fin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La fecha de inicio no puede ser mayor a la fecha fin"
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        fecha_venta = fecha_venta_sql(cursor)

        cursor.execute(
            f"""
            SELECT COUNT(*) AS cantidad_pedidos, COALESCE(SUM(total), 0) AS total_ventas
            FROM pedidos
            WHERE estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fecha_venta}) BETWEEN %s AND %s
            """,
            (fecha_inicio, fecha_fin)
        )
        resumen = cursor.fetchone()

        cursor.execute(
            f"""
            SELECT p.nombre,
                   SUM(dp.cantidad)  AS total_vendido,
                   SUM(dp.subtotal)  AS total_ingresos
            FROM detalle_pedidos dp
            JOIN productos p  ON dp.id_producto = p.id_producto
            JOIN pedidos    pe ON dp.id_pedido   = pe.id_pedido
            WHERE pe.estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fecha_venta.replace("created_at", "pe.created_at").replace("confirmado_at", "pe.confirmado_at")}) BETWEEN %s AND %s
            GROUP BY p.id_producto, p.nombre
            ORDER BY total_vendido DESC
            LIMIT 10
            """,
            (fecha_inicio, fecha_fin)
        )
        productos = cursor.fetchall()

        cursor.execute(
            f"""
            SELECT estado, COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total
            FROM pedidos
            WHERE DATE({fecha_venta}) BETWEEN %s AND %s
            GROUP BY estado
            ORDER BY FIELD(estado, 'pendiente', 'confirmado', 'en_preparacion', 'listo', 'entregado', 'cancelado')
            """,
            (fecha_inicio, fecha_fin)
        )
        estados = cursor.fetchall()

        # ── Generar CSV ──────────────────────────────────────────────
        # sep= en primera línea indica el separador a Excel sin depender del locale
        buf = io.StringIO()
        buf.write("sep=;\r\n")
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")

        w.writerow(["Maven Burger — Reporte de Ventas"])
        w.writerow([f"Período: {fecha_inicio} al {fecha_fin}"])
        w.writerow([])

        w.writerow(["RESUMEN"])
        w.writerow(["Métrica", "Valor"])
        w.writerow(["Total de ventas", f"{float(resumen['total_ventas']):.2f}"])
        w.writerow(["Pedidos contabilizados", resumen["cantidad_pedidos"]])
        w.writerow(["Estados de venta", "confirmado; en_preparacion; listo; entregado"])
        w.writerow([])

        w.writerow(["PEDIDOS POR ESTADO"])
        w.writerow(["Estado", "Cantidad", "Total"])
        for row in estados:
            w.writerow([
                row["estado"] or "sin_estado",
                row["cantidad"],
                f"{float(row['total']):.2f}",
            ])
        w.writerow([])

        w.writerow(["PRODUCTOS MÁS VENDIDOS"])
        w.writerow(["Producto", "Cantidad vendida", "Ingresos"])
        for p in productos:
            w.writerow([
                p["nombre"],
                p["total_vendido"],
                f"{float(p['total_ingresos']):.2f}",
            ])

        # BOM UTF-8 (\xef\xbb\xbf) para que Excel lo abra con encoding correcto
        csv_bytes = b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")

        filename = f"reporte_ventas_{fecha_inicio}_{fecha_fin}.csv"
        return Response(
            content=csv_bytes,
            media_type="text/csv; charset=utf-8-sig",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al generar reporte: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/dashboard")
def dashboard_metricas(current_user: dict = Depends(require_role("admin"))):
    """
    Retorna métricas operativas para el dashboard admin.
    Incluye ventas del día, pedidos activos, ticket promedio, producto destacado y mesas activas.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        fecha_venta = fecha_venta_sql(cursor)

        cursor.execute(
            f"""
            SELECT
                COUNT(*) AS pedidos_hoy
            FROM pedidos
            WHERE DATE(created_at) = CURDATE()
            """
        )
        resumen = cursor.fetchone()

        cursor.execute(
            f"""
            SELECT
                COALESCE(SUM(total), 0) AS ventas_hoy,
                COALESCE(AVG(total), 0) AS ticket_promedio
            FROM pedidos
            WHERE estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fecha_venta}) = CURDATE()
            """
        )
        ventas = cursor.fetchone()

        cursor.execute(
            """
            SELECT estado, COUNT(*) AS cantidad
            FROM pedidos
            WHERE estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo')
            GROUP BY estado
            """
        )
        estados = {row["estado"]: row["cantidad"] for row in cursor.fetchall()}

        cursor.execute(
            f"""
            SELECT p.nombre, SUM(dp.cantidad) AS cantidad
            FROM detalle_pedidos dp
            JOIN productos p ON p.id_producto = dp.id_producto
            JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
            WHERE DATE({fecha_venta.replace("created_at", "pe.created_at").replace("confirmado_at", "pe.confirmado_at")}) = CURDATE()
            GROUP BY p.id_producto, p.nombre
            ORDER BY cantidad DESC
            LIMIT 1
            """
        )
        producto_top = cursor.fetchone()

        cursor.execute(
            """
            SELECT COUNT(DISTINCT id_mesa) AS mesas_activas
            FROM pedidos
            WHERE estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo')
            """
        )
        mesas = cursor.fetchone()

        cursor.execute(
            f"""
            SELECT m.numero AS numero_mesa, COALESCE(SUM(p.total), 0) AS total_consumido
            FROM pedidos p
            JOIN mesas m ON m.id_mesa = p.id_mesa
            WHERE p.estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fecha_venta.replace("created_at", "p.created_at").replace("confirmado_at", "p.confirmado_at")}) = CURDATE()
            GROUP BY p.id_mesa, m.numero
            ORDER BY total_consumido DESC
            LIMIT 1
            """
        )
        mesa_top = cursor.fetchone()

        cobros_hoy = {"total": 0.0, "cantidad": 0, "metodos": {}}
        if cierres_mesa_existe(cursor):
            cursor.execute(
                """
                SELECT
                    COUNT(*) AS cantidad,
                    COALESCE(SUM(total_consumido), 0) AS total,
                    metodo_pago
                FROM cierres_mesa
                WHERE DATE(created_at) = CURDATE()
                GROUP BY metodo_pago
                """
            )
            for row in cursor.fetchall():
                cobros_hoy["cantidad"] += int(row["cantidad"])
                cobros_hoy["total"] += float(row["total"])
                cobros_hoy["metodos"][row["metodo_pago"]] = {
                    "cantidad": int(row["cantidad"]),
                    "total": float(row["total"]),
                }

        return {
            "ventas_hoy": float(ventas["ventas_hoy"]),
            "pedidos_hoy": int(resumen["pedidos_hoy"]),
            "ticket_promedio": float(ventas["ticket_promedio"]),
            "pedidos_activos": {
                "pendiente": estados.get("pendiente", 0),
                "confirmado": estados.get("confirmado", 0),
                "en_preparacion": estados.get("en_preparacion", 0),
                "listo": estados.get("listo", 0),
            },
            "producto_top": producto_top or {"nombre": "—", "cantidad": 0},
            "mesa_top": (
                {"numero": int(mesa_top["numero_mesa"]), "total": float(mesa_top["total_consumido"])}
                if mesa_top else {"numero": None, "total": 0.0}
            ),
            "mesas_activas": int(mesas["mesas_activas"]),
            "cobros_hoy": cobros_hoy,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener métricas: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/resumen-hoy")
def resumen_hoy_csv(
    fecha: date = Query(default=None, description="Fecha (YYYY-MM-DD). Por defecto: hoy."),
    current_user: dict = Depends(require_role("admin")),
):
    """
    Exporta el resumen operativo del dia como CSV.
    Incluye: ventas totales, cobros por metodo de pago, mesa mas productiva,
    producto top, pedidos por estado y serie horaria.
    El CSV usa separador ; y BOM UTF-8 para Excel (es-AR).
    """
    fecha_reporte = fecha or date.today()

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        fecha_venta = fecha_venta_sql(cursor)
        fv_p = fecha_venta.replace("created_at", "p.created_at").replace("confirmado_at", "p.confirmado_at")
        fv_plain = fecha_venta.replace("created_at", "pe.created_at").replace("confirmado_at", "pe.confirmado_at")

        cursor.execute(
            f"""
            SELECT COALESCE(SUM(total), 0) AS ventas_totales,
                   COUNT(*) AS pedidos_contabilizados,
                   COALESCE(AVG(total), 0) AS ticket_promedio
            FROM pedidos
            WHERE estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fecha_venta}) = %s
            """,
            (fecha_reporte,)
        )
        resumen = cursor.fetchone()

        cursor.execute(
            f"""
            SELECT estado, COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total
            FROM pedidos
            WHERE DATE({fecha_venta}) = %s
            GROUP BY estado
            ORDER BY FIELD(estado, 'pendiente','confirmado','en_preparacion','listo','entregado','cancelado')
            """,
            (fecha_reporte,)
        )
        por_estado = cursor.fetchall()

        cursor.execute(
            f"""
            SELECT m.numero AS numero_mesa, COALESCE(SUM(p.total), 0) AS total_consumido
            FROM pedidos p
            JOIN mesas m ON m.id_mesa = p.id_mesa
            WHERE p.estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fv_p}) = %s
            GROUP BY p.id_mesa, m.numero
            ORDER BY total_consumido DESC
            LIMIT 1
            """,
            (fecha_reporte,)
        )
        mesa_top = cursor.fetchone()

        cursor.execute(
            f"""
            SELECT p.nombre, SUM(dp.cantidad) AS cantidad_vendida,
                   SUM(dp.subtotal) AS total_ingresos
            FROM detalle_pedidos dp
            JOIN productos p  ON p.id_producto = dp.id_producto
            JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
            WHERE pe.estado IN ({ESTADOS_VENTA_SQL})
              AND DATE({fv_plain}) = %s
            GROUP BY p.id_producto, p.nombre
            ORDER BY cantidad_vendida DESC
            LIMIT 10
            """,
            (fecha_reporte,)
        )
        productos_top = cursor.fetchall()

        cobros_metodos = []
        if cierres_mesa_existe(cursor):
            cursor.execute(
                """
                SELECT metodo_pago,
                       COUNT(*) AS cantidad,
                       COALESCE(SUM(total_consumido), 0) AS total
                FROM cierres_mesa
                WHERE DATE(created_at) = %s
                GROUP BY metodo_pago
                ORDER BY total DESC
                """,
                (fecha_reporte,)
            )
            cobros_metodos = cursor.fetchall()

        cursor.execute(
            f"""
            SELECT HOUR({fecha_venta}) AS hora,
                   COUNT(*) AS pedidos,
                   COALESCE(SUM(total), 0) AS ventas
            FROM pedidos
            WHERE DATE({fecha_venta}) = %s
              AND estado IN ({ESTADOS_VENTA_SQL})
            GROUP BY HOUR({fecha_venta})
            ORDER BY hora
            """,
            (fecha_reporte,)
        )
        por_hora_raw = {int(r["hora"]): r for r in cursor.fetchall()}

        # ── Construir CSV ────────────────────────────────────────────
        buf = io.StringIO()
        buf.write("sep=;\r\n")
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")

        w.writerow(["Maven Burger — Resumen del día"])
        w.writerow([f"Fecha: {fecha_reporte}"])
        w.writerow([])

        w.writerow(["RESUMEN"])
        w.writerow(["Métrica", "Valor"])
        w.writerow(["Ventas totales", f"{float(resumen['ventas_totales']):.2f}"])
        w.writerow(["Pedidos contabilizados", resumen["pedidos_contabilizados"]])
        w.writerow(["Ticket promedio", f"{float(resumen['ticket_promedio']):.2f}"])
        if mesa_top:
            w.writerow(["Mesa más productiva", f"Mesa {mesa_top['numero_mesa']} (${float(mesa_top['total_consumido']):.2f})"])
        else:
            w.writerow(["Mesa más productiva", "—"])
        if productos_top:
            p = productos_top[0]
            w.writerow(["Producto más vendido", f"{p['nombre']} ({int(p['cantidad_vendida'])} unidades)"])
        else:
            w.writerow(["Producto más vendido", "—"])
        w.writerow([])

        if cobros_metodos:
            w.writerow(["COBROS POR MÉTODO DE PAGO"])
            w.writerow(["Método", "Cantidad de cierres", "Total cobrado"])
            for row in cobros_metodos:
                w.writerow([row["metodo_pago"], int(row["cantidad"]), f"{float(row['total']):.2f}"])
            w.writerow([])

        w.writerow(["PEDIDOS POR ESTADO"])
        w.writerow(["Estado", "Cantidad", "Total"])
        for row in por_estado:
            w.writerow([row["estado"] or "sin_estado", int(row["cantidad"]), f"{float(row['total']):.2f}"])
        w.writerow([])

        w.writerow(["PRODUCTOS MÁS VENDIDOS (TOP 10)"])
        w.writerow(["Producto", "Cantidad vendida", "Ingresos"])
        for p in productos_top:
            w.writerow([p["nombre"], int(p["cantidad_vendida"]), f"{float(p['total_ingresos']):.2f}"])
        w.writerow([])

        w.writerow(["VENTAS POR HORA"])
        w.writerow(["Hora", "Pedidos", "Ventas"])
        for hora in range(24):
            row = por_hora_raw.get(hora)
            w.writerow([
                f"{hora:02d}:00",
                int(row["pedidos"]) if row else 0,
                f"{float(row['ventas']):.2f}" if row else "0.00",
            ])

        csv_bytes = b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")
        filename = f"resumen_{fecha_reporte}.csv"
        return Response(
            content=csv_bytes,
            media_type="text/csv; charset=utf-8-sig",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al generar resumen: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/ventas-hoy")
def ventas_hoy_por_hora(current_user: dict = Depends(require_role("admin"))):
    """
    Retorna la serie de ventas del dia agrupada por hora para el grafico del dashboard.
    Se contabilizan pedidos confirmados o avanzados en el flujo operativo.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        fecha_venta = fecha_venta_sql(cursor)
        cursor.execute(
            f"""
            SELECT
                HOUR({fecha_venta}) AS hora,
                COUNT(*) AS pedidos,
                COALESCE(SUM(total), 0) AS ventas
            FROM pedidos
            WHERE DATE({fecha_venta}) = CURDATE()
              AND estado IN ({ESTADOS_VENTA_SQL})
            GROUP BY HOUR({fecha_venta})
            ORDER BY hora
            """
        )
        ventas_por_hora = {int(row["hora"]): row for row in cursor.fetchall()}

        horas_operativas = list(range(0, 24))
        serie = []
        for hora in horas_operativas:
            row = ventas_por_hora.get(hora)
            serie.append({
                "hora": hora,
                "label": f"{hora:02d}:00",
                "ventas": float(row["ventas"]) if row else 0.0,
                "pedidos": int(row["pedidos"]) if row else 0,
            })

        return {
            "fecha": date.today().isoformat(),
            "total_ventas": sum(item["ventas"] for item in serie),
            "total_pedidos": sum(item["pedidos"] for item in serie),
            "serie": serie,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener ventas por hora: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)
