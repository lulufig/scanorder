"""Tests del helper de paginación (app/utils/pagination.py) y del armado de
filtros/orden del catálogo de productos (routes/productos.py)."""
from unittest.mock import MagicMock

import pytest

from app.utils.pagination import respuesta_paginada, normalizar_limit, offset


@pytest.fixture(autouse=True)
def _limpiar_col_cache():
    """_col_cache es global en productos.py; sin limpiarlo, producto_tiene_columna
    devuelve el valor cacheado por un test anterior en vez de consultar el mock."""
    from app.routes.productos import _col_cache
    _col_cache.clear()
    yield
    _col_cache.clear()


class TestRespuestaPaginada:
    def test_forma_basica(self):
        r = respuesta_paginada([1, 2, 3], total=47, page=2, limit=15)
        assert r["items"] == [1, 2, 3]
        assert r["total"] == 47
        assert r["page"] == 2
        assert r["limit"] == 15
        assert r["pages"] == 4  # ceil(47/15)

    def test_pages_minimo_uno_con_cero_resultados(self):
        r = respuesta_paginada([], total=0, page=1, limit=15)
        assert r["pages"] == 1
        assert r["total"] == 0

    def test_division_exacta(self):
        assert respuesta_paginada([], total=30, page=1, limit=15)["pages"] == 2

    def test_extra_se_mergea(self):
        r = respuesta_paginada([], total=0, page=1, limit=15, resumen={"total": 5}, categorias=["a"])
        assert r["resumen"] == {"total": 5}
        assert r["categorias"] == ["a"]

    def test_page_nunca_menor_a_uno(self):
        assert respuesta_paginada([], total=0, page=0, limit=15)["page"] == 1


class TestNormalizarLimit:
    def test_valor_normal(self):
        assert normalizar_limit(15) == 15

    def test_cero_o_negativo_cae_al_default(self):
        assert normalizar_limit(0) == 15
        assert normalizar_limit(-3) == 15

    def test_tope_maximo(self):
        assert normalizar_limit(9999) == 100


class TestOffset:
    def test_primera_pagina(self):
        assert offset(1, 15) == 0

    def test_tercera_pagina(self):
        assert offset(3, 15) == 30

    def test_pagina_invalida_no_da_negativo(self):
        assert offset(0, 15) == 0


class TestFiltroCatalogo:
    def _cursor(self, tiene_subcategoria=True):
        cur = MagicMock()
        # producto_tiene_columna("subcategoria") -> fetchone truthy/None
        cur.fetchone.return_value = {"Field": "subcategoria"} if tiene_subcategoria else None
        return cur

    def test_sin_filtros_where_vacio(self):
        from app.routes.productos import _filtro_catalogo
        where, params = _filtro_catalogo(self._cursor(), None, "todos", None)
        assert where == ""
        assert params == []

    def test_estado_disponibles(self):
        from app.routes.productos import _filtro_catalogo
        where, params = _filtro_catalogo(self._cursor(), None, "disponibles", None)
        assert "p.disponible = TRUE" in where
        assert params == []

    def test_estado_no_disponibles(self):
        from app.routes.productos import _filtro_catalogo
        where, _ = _filtro_catalogo(self._cursor(), None, "no-disponibles", None)
        assert "p.disponible = FALSE" in where

    def test_categoria_exacta(self):
        from app.routes.productos import _filtro_catalogo
        where, params = _filtro_catalogo(self._cursor(), None, "todos", "Comidas")
        assert "c.nombre = %s" in where
        assert params == ["Comidas"]

    def test_busqueda_incluye_subcategoria_si_existe(self):
        from app.routes.productos import _filtro_catalogo
        where, params = _filtro_catalogo(self._cursor(tiene_subcategoria=True), "burger", "todos", None)
        assert "p.subcategoria LIKE %s" in where
        assert params == ["%burger%"] * 4

    def test_busqueda_sin_subcategoria(self):
        from app.routes.productos import _filtro_catalogo
        where, params = _filtro_catalogo(self._cursor(tiene_subcategoria=False), "burger", "todos", None)
        assert "p.subcategoria" not in where
        assert params == ["%burger%"] * 3

    def test_orden_cubre_todas_las_opciones_del_frontend(self):
        from app.routes.productos import _ORDEN_CATALOGO
        for opcion in ["mas-vendidos", "categoria", "recientes", "az", "precio-asc", "precio-desc"]:
            assert opcion in _ORDEN_CATALOGO


class TestEstadoInventario:
    def test_estado_stock_espeja_normalizarEstado_js(self):
        from app.routes.inventario import _estado_stock
        assert _estado_stock(0, 5) == "AGOTADO"
        assert _estado_stock(-1, 5) == "AGOTADO"
        assert _estado_stock(3, 10) == "BAJO"
        assert _estado_stock(10, 10) == "OK"
        assert _estado_stock(3, 0) == "OK"     # sin mínimo definido → nunca "BAJO"
        assert _estado_stock(20, 5) == "OK"

    def test_filtro_estado_cubre_las_opciones_del_frontend(self):
        from app.routes.inventario import _FILTRO_ESTADO
        for opcion in ["OK", "BAJO", "AGOTADO", "CRITICOS"]:
            assert opcion in _FILTRO_ESTADO
            assert "p.stock_actual" in _FILTRO_ESTADO[opcion]
