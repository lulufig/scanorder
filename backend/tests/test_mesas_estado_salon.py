"""
Tests de unidad para _calcular_estado_salon() (app/routes/mesas.py).

Es una función pura extraída de mapa_mesas() precisamente para ser testeable
sin conexión a MySQL ni mocks de cursor. Cubre la prioridad de los distintos
estados de salón (abandonada > cuenta > esperando > pedido_activo > pidiendo
> ocupada > libre) y los casos límite de los umbrales de tiempo.

No requieren MySQL.
"""
from app.routes.mesas import _calcular_estado_salon


def _calc(
    session=None,
    pedidos_activos=0,
    items_carrito=0,
    participantes=0,
    minutos_desde_scan=None,
    minutos_espera=None,
    estado_operativo=None,
):
    return _calcular_estado_salon(
        session=session,
        pedidos_activos=pedidos_activos,
        items_carrito=items_carrito,
        participantes=participantes,
        minutos_desde_scan=minutos_desde_scan,
        minutos_espera=minutos_espera,
        estado_operativo=estado_operativo or {},
    )


class TestEstadoLibre:
    def test_sin_datos_es_libre(self):
        estado, abandonada = _calc()
        assert estado == "libre"
        assert abandonada is False


class TestEstadoOcupada:
    def test_participantes_sin_pedidos_ni_carrito_es_ocupada(self):
        estado, abandonada = _calc(session={"mesa": 1}, participantes=2, minutos_desde_scan=1)
        assert estado == "ocupada"
        assert abandonada is False

    def test_estado_operativo_ocupada_sin_sesion_es_ocupada(self):
        estado, _ = _calc(estado_operativo={"ocupada": True})
        assert estado == "ocupada"


class TestEstadoPidiendo:
    def test_items_en_carrito_sin_pedidos_es_pidiendo(self):
        estado, _ = _calc(session={"mesa": 1}, items_carrito=3, minutos_desde_scan=1)
        assert estado == "pidiendo"

    def test_pidiendo_tiene_prioridad_sobre_ocupada(self):
        estado, _ = _calc(
            session={"mesa": 1}, items_carrito=1, participantes=4, minutos_desde_scan=1
        )
        assert estado == "pidiendo"


class TestEstadoPedidoActivo:
    def test_pedidos_activos_con_espera_baja_es_pedido_activo(self):
        estado, _ = _calc(pedidos_activos=1, minutos_espera=5)
        assert estado == "pedido_activo"

    def test_pedido_activo_tiene_prioridad_sobre_pidiendo(self):
        estado, _ = _calc(pedidos_activos=1, items_carrito=2, minutos_espera=5)
        assert estado == "pedido_activo"


class TestEstadoEsperando:
    def test_espera_igual_a_20_minutos_es_esperando(self):
        estado, _ = _calc(pedidos_activos=1, minutos_espera=20)
        assert estado == "esperando"

    def test_espera_19_minutos_no_es_esperando(self):
        estado, _ = _calc(pedidos_activos=1, minutos_espera=19)
        assert estado == "pedido_activo"

    def test_sin_pedidos_activos_no_es_esperando_aunque_haya_espera_alta(self):
        estado, _ = _calc(pedidos_activos=0, minutos_espera=999, items_carrito=1, session={"mesa": 1}, minutos_desde_scan=1)
        assert estado == "pidiendo"


class TestEstadoCuenta:
    def test_cuenta_solicitada_tiene_prioridad_sobre_esperando(self):
        estado, _ = _calc(
            pedidos_activos=1, minutos_espera=999, estado_operativo={"cuenta_solicitada": True}
        )
        assert estado == "cuenta"

    def test_cuenta_solicitada_tiene_prioridad_sobre_ocupada(self):
        estado, _ = _calc(
            session={"mesa": 1}, participantes=3, minutos_desde_scan=1,
            estado_operativo={"cuenta_solicitada": True},
        )
        assert estado == "cuenta"


class TestEstadoAbandonada:
    def test_sesion_sin_actividad_10_minutos_es_abandonada(self):
        estado, abandonada = _calc(session={"mesa": 1}, minutos_desde_scan=10)
        assert estado == "abandonada"
        assert abandonada is True

    def test_sesion_sin_actividad_9_minutos_no_es_abandonada(self):
        estado, abandonada = _calc(session={"mesa": 1}, participantes=1, minutos_desde_scan=9)
        assert abandonada is False
        assert estado == "ocupada"

    def test_sin_sesion_nunca_es_abandonada_aunque_pase_el_tiempo(self):
        estado, abandonada = _calc(session=None, minutos_desde_scan=999)
        assert abandonada is False
        assert estado == "libre"

    def test_con_pedidos_activos_no_es_abandonada(self):
        estado, abandonada = _calc(
            session={"mesa": 1}, pedidos_activos=1, minutos_desde_scan=999, minutos_espera=1
        )
        assert abandonada is False
        assert estado == "pedido_activo"

    def test_con_items_en_carrito_no_es_abandonada(self):
        estado, abandonada = _calc(
            session={"mesa": 1}, items_carrito=1, minutos_desde_scan=999
        )
        assert abandonada is False
        assert estado == "pidiendo"

    def test_abandonada_tiene_prioridad_sobre_cuenta_solicitada(self):
        """abandonada se evalúa primero en el if/elif — aunque el estado
        operativo tenga cuenta_solicitada=True, si la mesa cumple los
        criterios de abandono ese es el estado que se devuelve."""
        estado, abandonada = _calc(
            session={"mesa": 1}, minutos_desde_scan=15,
            estado_operativo={"cuenta_solicitada": True},
        )
        assert abandonada is True
        assert estado == "abandonada"

    def test_minutos_desde_scan_none_no_es_abandonada(self):
        estado, abandonada = _calc(session={"mesa": 1}, minutos_desde_scan=None)
        assert abandonada is False
