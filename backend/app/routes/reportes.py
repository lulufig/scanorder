import os
import tempfile
from datetime import date

from fastapi import APIRouter, HTTPException, status, Depends, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

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
    Genera un PDF con el reporte de ventas entre las fechas indicadas.
    Incluye total de ventas, cantidad de pedidos y productos más vendidos.
    Solo administradores.
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

        # ── Generar PDF ──────────────────────────────────────────────
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.close()

        doc      = SimpleDocTemplate(tmp.name, pagesize=A4)
        styles   = getSampleStyleSheet()
        elements = []

        elements.append(Paragraph("Maven Burger — Reporte de Ventas", styles["Title"]))
        elements.append(Paragraph(
            f"Período: {fecha_inicio} al {fecha_fin}",
            styles["Normal"]
        ))
        elements.append(Spacer(1, 20))

        # Resumen
        elements.append(Paragraph("Resumen", styles["Heading2"]))
        resumen_data = [
            ["Métrica", "Valor"],
            ["Total de ventas", f"${float(resumen['total_ventas']):.2f}"],
            ["Pedidos contabilizados", str(resumen["cantidad_pedidos"])],
            ["Estados de venta", "confirmado, en_preparacion, listo, entregado"],
        ]
        tabla_resumen = Table(resumen_data, colWidths=[280, 180])
        tabla_resumen.setStyle(TableStyle([
            ("BACKGROUND",     (0, 0), (-1, 0),  colors.HexColor("#C0392B")),
            ("TEXTCOLOR",      (0, 0), (-1, 0),  colors.white),
            ("FONTNAME",       (0, 0), (-1, 0),  "Helvetica-Bold"),
            ("GRID",           (0, 0), (-1, -1), 0.5, colors.grey),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.white]),
        ]))
        elements.append(tabla_resumen)
        elements.append(Spacer(1, 24))

        # Productos más vendidos
        if estados:
            elements.append(Paragraph("Pedidos por estado", styles["Heading2"]))
            estados_data = [["Estado", "Cantidad", "Total"]]
            for row in estados:
                estados_data.append([
                    row["estado"] or "sin_estado",
                    str(row["cantidad"]),
                    f"${float(row['total']):.2f}",
                ])
            tabla_estados = Table(estados_data, colWidths=[190, 90, 180])
            tabla_estados.setStyle(TableStyle([
                ("BACKGROUND",     (0, 0), (-1, 0),  colors.HexColor("#21130F")),
                ("TEXTCOLOR",      (0, 0), (-1, 0),  colors.white),
                ("FONTNAME",       (0, 0), (-1, 0),  "Helvetica-Bold"),
                ("GRID",           (0, 0), (-1, -1), 0.5, colors.grey),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.white]),
            ]))
            elements.append(tabla_estados)
            elements.append(Spacer(1, 24))

        if productos:
            elements.append(Paragraph("Productos más vendidos", styles["Heading2"]))
            prod_data = [["Producto", "Cantidad", "Ingresos"]]
            for p in productos:
                prod_data.append([
                    p["nombre"],
                    str(p["total_vendido"]),
                    f"${float(p['total_ingresos']):.2f}",
                ])
            tabla_prod = Table(prod_data, colWidths=[280, 90, 90])
            tabla_prod.setStyle(TableStyle([
                ("BACKGROUND",     (0, 0), (-1, 0),  colors.HexColor("#C0392B")),
                ("TEXTCOLOR",      (0, 0), (-1, 0),  colors.white),
                ("FONTNAME",       (0, 0), (-1, 0),  "Helvetica-Bold"),
                ("GRID",           (0, 0), (-1, -1), 0.5, colors.grey),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.white]),
            ]))
            elements.append(tabla_prod)
        else:
            elements.append(Paragraph(
                "No hay productos vendidos en el período seleccionado.",
                styles["Normal"]
            ))

        doc.build(elements)

        return FileResponse(
            path=tmp.name,
            media_type="application/pdf",
            filename=f"reporte_ventas_{fecha_inicio}_{fecha_fin}.pdf",
            background=BackgroundTask(os.unlink, tmp.name)
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
