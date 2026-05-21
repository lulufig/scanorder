from app.routes.pedidos import TRANSICION_ESTADO
from app.schemas.pedidos import PedidoCreate, EstadoUpdate


def test_pedido_create_acepta_observaciones_y_qr_token():
    pedido = PedidoCreate(
        id_mesa=1,
        qr_token="token-publico",
        client_id="cliente-host",
        observaciones="sin cebolla",
        productos=[{"id_producto": 10, "cantidad": 2}],
    )

    assert pedido.id_mesa == 1
    assert pedido.qr_token == "token-publico"
    assert pedido.client_id == "cliente-host"
    assert pedido.observaciones == "sin cebolla"
    assert pedido.productos[0].cantidad == 2


def test_transiciones_de_estado_en_orden():
    assert TRANSICION_ESTADO["pendiente"] == "confirmado"
    assert TRANSICION_ESTADO["confirmado"] == "en_preparacion"
    assert TRANSICION_ESTADO["en_preparacion"] == "listo"
    assert TRANSICION_ESTADO["listo"] == "entregado"


def test_estado_update_rechaza_estado_no_permitido():
    try:
        EstadoUpdate(estado="cancelado")
    except Exception as exc:
        assert "cancelado" in str(exc)
    else:
        raise AssertionError("EstadoUpdate aceptó un estado fuera del flujo de cocina")
