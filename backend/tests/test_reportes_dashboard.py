"""
Tests para la lógica del dashboard y el export CSV de resumen diario.

No requieren MySQL: se mockea get_db_connection() con cursores que devuelven
datos sintéticos, verificando el procesamiento de los resultados.

Orden de fetchone/fetchall en dashboard_metricas (caché vacío):
  fetchone: [SHOW_COLUMNS, pedidos_hoy, ventas, producto_top, mesas, mesa_top, SHOW_TABLES]
  fetchall: [estados]

Orden en resumen_hoy_csv (caché vacío):
  fetchone: [SHOW_COLUMNS, resumen, mesa_top, SHOW_TABLES]
  fetchall: [por_estado, productos_top, por_hora]
"""
import io
import csv
import pytest
from datetime import date
from unittest.mock import MagicMock, patch


# ────────────────────────────────────────────────────────────────────────────
# Fixture — limpia el caché entre tests
# ────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_col_cache():
    """
    _col_cache es global en reportes.py. Si queda poblado de un test anterior,
    las llamadas SHOW COLUMNS / SHOW TABLES se saltan y el orden del mock cambia.
    Lo limpiamos antes y después de cada test.
    """
    from app.routes.reportes import _col_cache
    _col_cache.clear()
    yield
    _col_cache.clear()


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────

def _mock_conn(fetchone_seq, fetchall_seq):
    cursor = MagicMock()
    cursor.fetchone.side_effect = list(fetchone_seq)
    cursor.fetchall.side_effect = list(fetchall_seq)
    conn = MagicMock()
    conn.cursor.return_value = cursor
    return conn


def _call_dashboard(conn):
    from app.routes.reportes import dashboard_metricas
    with patch("app.routes.reportes.get_db_connection", return_value=conn), \
         patch("app.routes.reportes.close_db_connection"):
        return dashboard_metricas(current_user={"id": 1, "rol": "admin"})


def _call_resumen_hoy(conn, fecha=None):
    from app.routes.reportes import resumen_hoy_csv
    with patch("app.routes.reportes.get_db_connection", return_value=conn), \
         patch("app.routes.reportes.close_db_connection"):
        return resumen_hoy_csv(fecha=fecha, current_user={"id": 1, "rol": "admin"})


# ────────────────────────────────────────────────────────────────────────────
# /reportes/dashboard — campo mesa_top
# ────────────────────────────────────────────────────────────────────────────

# Secuencias de mock para dashboard (caché vacío):
#   fetchone: SHOW_COLUMNS, pedidos_hoy, ventas, producto_top(LIMIT 1), mesas, mesa_top, SHOW_TABLES
#   fetchall: estados
_DASH_FETCHONE_BASE = [
    None,                                                    # SHOW COLUMNS confirmado_at
    {"pedidos_hoy": 5},                                      # pedidos_hoy
    {"ventas_hoy": 1500.0, "ticket_promedio": 300.0},        # ventas + ticket_promedio
    {"nombre": "Smash Burger", "cantidad": 8},               # producto_top (fetchone, LIMIT 1)
    {"mesas_activas": 3},                                    # mesas_activas
    {"numero_mesa": 7, "total_consumido": 950.0},            # mesa_top
    None,                                                    # SHOW TABLES cierres_mesa → no existe
]
_DASH_FETCHALL_BASE = [
    [{"estado": "listo", "cantidad": 3}],                    # estados (pedidos_activos)
]


class TestDashboardMesaTop:
    def test_mesa_top_presente_en_respuesta(self):
        conn = _mock_conn(_DASH_FETCHONE_BASE, _DASH_FETCHALL_BASE)
        result = _call_dashboard(conn)
        assert "mesa_top" in result
        assert result["mesa_top"]["numero"] == 7
        assert abs(result["mesa_top"]["total"] - 950.0) < 0.01

    def test_mesa_top_fallback_cuando_no_hay_ventas(self):
        fetchone = [
            None,
            {"pedidos_hoy": 0},
            {"ventas_hoy": 0.0, "ticket_promedio": 0.0},
            None,                                            # producto_top → None
            {"mesas_activas": 0},
            None,                                            # mesa_top → None (sin ventas)
            None,                                            # SHOW TABLES cierres_mesa
        ]
        conn = _mock_conn(fetchone, [[]])                    # estados vacío
        result = _call_dashboard(conn)
        assert result["mesa_top"] == {"numero": None, "total": 0.0}

    def test_dashboard_incluye_todos_los_campos_requeridos(self):
        conn = _mock_conn(_DASH_FETCHONE_BASE, _DASH_FETCHALL_BASE)
        result = _call_dashboard(conn)
        for campo in [
            "ventas_hoy", "pedidos_hoy", "ticket_promedio",
            "pedidos_activos", "producto_top", "mesa_top",
            "mesas_activas", "cobros_hoy",
        ]:
            assert campo in result, f"Falta campo '{campo}'"

    def test_cobros_hoy_incluye_metodos_cuando_cierres_existe(self):
        fetchone = [
            None,
            {"pedidos_hoy": 3},
            {"ventas_hoy": 900.0, "ticket_promedio": 300.0},
            {"nombre": "Papas XL", "cantidad": 6},
            {"mesas_activas": 2},
            {"numero_mesa": 2, "total_consumido": 900.0},
            {"Tables_in_scanorder_db": "cierres_mesa"},      # SHOW TABLES → existe
        ]
        fetchall = [
            [{"estado": "listo", "cantidad": 3}],
            [
                {"metodo_pago": "efectivo", "cantidad": 2, "total": 600.0},
                {"metodo_pago": "tarjeta",  "cantidad": 1, "total": 300.0},
            ],
        ]
        conn = _mock_conn(fetchone, fetchall)
        result = _call_dashboard(conn)
        assert result["cobros_hoy"]["total"] == 900.0
        assert "efectivo" in result["cobros_hoy"]["metodos"]
        assert "tarjeta"  in result["cobros_hoy"]["metodos"]


# ────────────────────────────────────────────────────────────────────────────
# /reportes/resumen-hoy — estructura del CSV
# ────────────────────────────────────────────────────────────────────────────

# Secuencias para resumen_hoy_csv (caché vacío):
#   fetchone: SHOW_COLUMNS, resumen, mesa_top, SHOW_TABLES
#   fetchall: por_estado, productos_top, por_hora
_RESUMEN_FETCHONE = [
    None,
    {"ventas_totales": 2400.0, "pedidos_contabilizados": 6, "ticket_promedio": 400.0},
    {"numero_mesa": 5, "total_consumido": 1200.0},
    None,                                                    # cierres_mesa no existe
]
_RESUMEN_FETCHALL = [
    [{"estado": "entregado", "cantidad": 6, "total": 2400.0}],
    [{"nombre": "Smash Burger", "cantidad_vendida": 12, "total_ingresos": 1440.0}],
    [
        {"hora": 12, "pedidos": 3, "ventas": 1200.0},
        {"hora": 19, "pedidos": 3, "ventas": 1200.0},
    ],
]


class TestResumenHoyCSV:
    def _response(self, fecha=None):
        conn = _mock_conn(_RESUMEN_FETCHONE, _RESUMEN_FETCHALL)
        return _call_resumen_hoy(conn, fecha=fecha)

    def test_csv_tiene_bom_utf8(self):
        r = self._response()
        assert r.body[:3] == b"\xef\xbb\xbf", "Falta BOM UTF-8"

    def test_csv_primera_linea_sep(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        assert texto.startswith("sep=;")

    def test_csv_separador_punto_y_coma(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        # Skip la primera línea "sep=;"
        cuerpo = texto.split("\r\n", 1)[1]
        reader = csv.reader(io.StringIO(cuerpo), delimiter=";")
        rows = list(reader)
        venta_rows = [row for row in rows if row and row[0] == "Ventas totales"]
        assert len(venta_rows) == 1
        assert venta_rows[0][1] == "2400.00"

    def test_csv_contiene_secciones_requeridas(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        for seccion in ["RESUMEN", "PEDIDOS POR ESTADO", "PRODUCTOS MÁS VENDIDOS", "VENTAS POR HORA"]:
            assert seccion in texto, f"Falta sección '{seccion}'"

    def test_csv_contiene_mesa_top(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        assert "Mesa 5" in texto
        assert "1200.00" in texto

    def test_csv_serie_horaria_tiene_24_filas(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        # Contar filas de hora después del encabezado de la sección
        cuerpo = texto.split("\r\n", 1)[1]
        reader = csv.reader(io.StringIO(cuerpo), delimiter=";")
        hora_rows = [row for row in reader if row and row[0].endswith(":00") and len(row[0]) == 5]
        assert len(hora_rows) == 24, f"La serie horaria debe tener 24 filas, tiene {len(hora_rows)}"

    def test_csv_acepta_fecha_explicita(self):
        r = self._response(fecha=date(2026, 1, 15))
        texto = r.body[3:].decode("utf-8")
        assert "2026-01-15" in texto

    def test_content_disposition_incluye_fecha(self):
        conn = _mock_conn(_RESUMEN_FETCHONE, _RESUMEN_FETCHALL)
        r = _call_resumen_hoy(conn, fecha=date(2026, 3, 20))
        cd = r.headers.get("content-disposition", "")
        assert "2026-03-20" in cd

    def test_media_type_es_csv_utf8(self):
        r = self._response()
        assert "text/csv" in r.media_type

    def test_csv_sin_cierres_omite_seccion_cobros(self):
        r = self._response()
        texto = r.body[3:].decode("utf-8")
        # Con el mock que devuelve None para cierres_mesa, no debe aparecer la sección
        assert "COBROS POR MÉTODO" not in texto

    def test_csv_con_cierres_incluye_seccion_cobros(self):
        fetchone = [
            None,
            {"ventas_totales": 900.0, "pedidos_contabilizados": 3, "ticket_promedio": 300.0},
            {"numero_mesa": 2, "total_consumido": 900.0},
            {"Tables_in_scanorder_db": "cierres_mesa"},      # existe
        ]
        fetchall = [
            [{"estado": "entregado", "cantidad": 3, "total": 900.0}],
            [{"nombre": "Papas XL", "cantidad_vendida": 9, "total_ingresos": 540.0}],
            [{"metodo_pago": "efectivo", "cantidad": 2, "total": 600.0},
             {"metodo_pago": "tarjeta",  "cantidad": 1, "total": 300.0}],
            [{"hora": 13, "pedidos": 3, "ventas": 900.0}],
        ]
        conn = _mock_conn(fetchone, fetchall)
        r = _call_resumen_hoy(conn)
        texto = r.body[3:].decode("utf-8")
        assert "COBROS POR MÉTODO DE PAGO" in texto
        assert "efectivo" in texto
        assert "tarjeta"  in texto


# ────────────────────────────────────────────────────────────────────────────
# Helpers del módulo (lógica pura sin DB)
# ────────────────────────────────────────────────────────────────────────────

class TestHelpers:
    def test_fecha_venta_sql_usa_created_at_sin_columna(self):
        from app.routes.reportes import fecha_venta_sql
        cursor = MagicMock()
        cursor.fetchone.return_value = None          # confirmado_at no existe
        assert fecha_venta_sql(cursor) == "created_at"

    def test_fecha_venta_sql_usa_coalesce_si_columna_existe(self):
        from app.routes.reportes import fecha_venta_sql
        cursor = MagicMock()
        cursor.fetchone.return_value = {"Field": "confirmado_at"}
        result = fecha_venta_sql(cursor)
        assert "confirmado_at" in result
        assert "COALESCE" in result
