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

        cursor.execute(
            """
            SELECT COUNT(*) AS cantidad_pedidos, COALESCE(SUM(total), 0) AS total_ventas
            FROM pedidos
            WHERE estado IN ('listo', 'entregado')
              AND DATE(created_at) BETWEEN %s AND %s
            """,
            (fecha_inicio, fecha_fin)
        )
        resumen = cursor.fetchone()

        cursor.execute(
            """
            SELECT p.nombre,
                   SUM(dp.cantidad)  AS total_vendido,
                   SUM(dp.subtotal)  AS total_ingresos
            FROM detalle_pedidos dp
            JOIN productos p  ON dp.id_producto = p.id_producto
            JOIN pedidos    pe ON dp.id_pedido   = pe.id_pedido
            WHERE pe.estado IN ('listo', 'entregado')
              AND DATE(pe.created_at) BETWEEN %s AND %s
            GROUP BY p.id_producto, p.nombre
            ORDER BY total_vendido DESC
            LIMIT 10
            """,
            (fecha_inicio, fecha_fin)
        )
        productos = cursor.fetchall()

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
            ["Cantidad de pedidos", str(resumen["cantidad_pedidos"])],
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

        cursor.execute(
            """
            SELECT
                COUNT(*) AS pedidos_hoy,
                COALESCE(SUM(CASE WHEN estado IN ('listo', 'entregado') THEN total ELSE 0 END), 0) AS ventas_hoy,
                COALESCE(AVG(CASE WHEN estado IN ('listo', 'entregado') THEN total ELSE NULL END), 0) AS ticket_promedio
            FROM pedidos
            WHERE DATE(created_at) = CURDATE()
            """
        )
        resumen = cursor.fetchone()

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
            """
            SELECT p.nombre, SUM(dp.cantidad) AS cantidad
            FROM detalle_pedidos dp
            JOIN productos p ON p.id_producto = dp.id_producto
            JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
            WHERE DATE(pe.created_at) = CURDATE()
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

        return {
            "ventas_hoy": float(resumen["ventas_hoy"]),
            "pedidos_hoy": int(resumen["pedidos_hoy"]),
            "ticket_promedio": float(resumen["ticket_promedio"]),
            "pedidos_activos": {
                "pendiente": estados.get("pendiente", 0),
                "confirmado": estados.get("confirmado", 0),
                "en_preparacion": estados.get("en_preparacion", 0),
                "listo": estados.get("listo", 0),
            },
            "producto_top": producto_top or {"nombre": "—", "cantidad": 0},
            "mesas_activas": int(mesas["mesas_activas"]),
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
