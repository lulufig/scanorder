from fastapi import HTTPException

from app.routes.productos import resolver_id_categoria
from app.schemas.productos import ProductoCreate


class FakeCursor:
    def __init__(self):
        self.lastrowid = 99
        self.queries = []
        self.fetchone_result = None

    def execute(self, query, params=None):
        self.queries.append((query, params))
        if "LOWER(nombre)" in query and params and params[0] == "Acompañamientos":
            self.fetchone_result = {"id_categoria": 2}
        elif "id_categoria = %s" in query and params and params[0] == 1:
            self.fetchone_result = {"id_categoria": 1}
        else:
            self.fetchone_result = None

    def fetchone(self):
        return self.fetchone_result


def test_producto_create_acepta_categoria_por_nombre():
    producto = ProductoCreate(
        nombre="Papas",
        precio=1000,
        categoria="papas",
    )

    assert producto.categoria == "papas"
    assert producto.id_categoria is None


def test_resolver_id_categoria_por_alias_papas():
    cursor = FakeCursor()

    assert resolver_id_categoria(cursor, categoria="papas") == 2


def test_resolver_id_categoria_explicito():
    cursor = FakeCursor()

    assert resolver_id_categoria(cursor, id_categoria=1) == 1


def test_resolver_id_categoria_rechaza_id_inexistente():
    cursor = FakeCursor()

    try:
        resolver_id_categoria(cursor, id_categoria=123)
    except HTTPException as exc:
        assert exc.status_code == 400
    else:
        raise AssertionError("Se aceptó una categoría inexistente")
