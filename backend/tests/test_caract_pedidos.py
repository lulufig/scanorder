"""
Tests de caracterización — PASO 0 del refactor refactor/layered-architecture.

Capturan el comportamiento observable ANTES de mover código entre módulos.
Deben pasar sin cambios ni ANTES ni DESPUÉS del refactor. Si alguno cambia de
resultado el refactor introdujo un cambio de comportamiento — parar y reportar.

No dependen de MySQL: prueban lógica pura (cálculos, state machines, estructuras
de mensajes WS). Las rutas HTTP y el cierre de mesa ya están cubiertos en
test_pedidos.py y test_mesas_cierre.py respectivamente.
"""
from datetime import datetime, timezone, timedelta


# ── 1. session_key ────────────────────────────────────────────────────────────

def test_session_key_con_token():
    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    assert mgr.session_key(5, "abc123") == "5:abc123"


def test_session_key_sin_token():
    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    assert mgr.session_key(3, None) == "3:"
    assert mgr.session_key(3, "") == "3:"


# ── 2. MesaOperationalState — valores por defecto al hacer touch ──────────────

def test_touch_crea_estado_con_defaults(monkeypatch):
    """touch() inicializa ocupada=True y los flags de servicio en False."""
    import app.services.mesa_state as mod
    monkeypatch.setattr(mod, "persist_operational_state", lambda *_a, **_k: None)

    from app.services.mesa_state import MesaOperationalState
    state = MesaOperationalState()
    state.touch(7, ocupada=True)

    s = state.states[7]
    assert s["ocupada"] is True
    assert s["cuenta_solicitada"] is False
    assert s["mozo_solicitado"] is False


def test_touch_actualiza_flags_de_servicio(monkeypatch):
    import app.services.mesa_state as mod
    monkeypatch.setattr(mod, "persist_operational_state", lambda *_a, **_k: None)

    from app.services.mesa_state import MesaOperationalState
    state = MesaOperationalState()
    state.touch(8, ocupada=True, cuenta_solicitada=True)
    assert state.states[8]["cuenta_solicitada"] is True
    assert state.states[8]["mozo_solicitado"] is False


def test_release_elimina_estado_de_memoria(monkeypatch):
    import app.services.mesa_state as mod
    monkeypatch.setattr(mod, "persist_operational_state", lambda *_a, **_k: None)
    monkeypatch.setattr(mod, "release_operational_state", lambda *_a, **_k: None)

    from app.services.mesa_state import MesaOperationalState
    state = MesaOperationalState()
    state.touch(9, ocupada=True)
    assert 9 in state.states

    state.release(9)
    assert 9 not in state.states


# ── 3. MesaSessionManager — disconnect y limpieza de sesión ──────────────────

def test_disconnect_con_carrito_vacio_y_sin_clientes_limpia_sesion(monkeypatch):
    """Si no quedan clientes Y el carrito está vacío, la sesión se elimina."""
    import app.services.mesa_sessions as mod
    monkeypatch.setattr(mod, "persist_session_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(mod, "delete_session_snapshot", lambda *_a, **_k: None)

    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    key = "5:tok"
    mgr.sessions[key] = {
        "mesa": 5,
        "host_client_id": "c1",
        "clients": {"c1": {"nombre": "A", "websocket": None}},
        "carrito": [],
        "observaciones": "",
        "created_at": datetime.now(timezone.utc),
        "last_activity_at": datetime.now(timezone.utc),
    }

    mgr.disconnect(key, "c1")
    assert key not in mgr.sessions


def test_disconnect_con_carrito_mantiene_sesion(monkeypatch):
    """Si quedan items en el carrito, la sesión persiste aunque no haya clientes."""
    import app.services.mesa_sessions as mod
    monkeypatch.setattr(mod, "persist_session_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(mod, "delete_session_snapshot", lambda *_a, **_k: None)

    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    key = "6:tok"
    mgr.sessions[key] = {
        "mesa": 6,
        "host_client_id": "c1",
        "clients": {"c1": {"nombre": "A", "websocket": None}},
        "carrito": [{"id_producto": 1, "cantidad": 2, "precio": 500}],
        "observaciones": "",
        "created_at": datetime.now(timezone.utc),
        "last_activity_at": datetime.now(timezone.utc),
    }

    mgr.disconnect(key, "c1")
    assert key in mgr.sessions


def test_disconnect_reasigna_host_si_se_va_el_host(monkeypatch):
    """Cuando el host se desconecta y queda otro cliente, el host cambia."""
    import app.services.mesa_sessions as mod
    monkeypatch.setattr(mod, "persist_session_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(mod, "delete_session_snapshot", lambda *_a, **_k: None)

    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    key = "7:tok"
    mgr.sessions[key] = {
        "mesa": 7,
        "host_client_id": "c1",
        "clients": {
            "c1": {"nombre": "Host", "websocket": None},
            "c2": {"nombre": "Guest", "websocket": None},
        },
        "carrito": [],
        "observaciones": "",
        "created_at": datetime.now(timezone.utc),
        "last_activity_at": datetime.now(timezone.utc),
    }

    mgr.disconnect(key, "c1")
    assert mgr.sessions[key]["host_client_id"] == "c2"


# ── 4. force_release — libera todas las sesiones de una mesa ─────────────────

def test_force_release_elimina_todas_las_sesiones_de_la_mesa(monkeypatch):
    import app.services.mesa_sessions as mod
    monkeypatch.setattr(mod, "delete_session_snapshot", lambda *_a, **_k: None)

    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    mgr.sessions["10:tokA"] = {"mesa": 10, "clients": {}, "carrito": []}
    mgr.sessions["10:tokB"] = {"mesa": 10, "clients": {}, "carrito": []}
    mgr.sessions["11:tokC"] = {"mesa": 11, "clients": {}, "carrito": []}

    mgr.force_release(10)

    assert "10:tokA" not in mgr.sessions
    assert "10:tokB" not in mgr.sessions
    assert "11:tokC" in mgr.sessions  # mesa distinta, no se toca


# ── 5. Cálculo "abandonada" — lógica que se va a extraer a función pura ──────

def _es_abandonada(session, pedidos_activos: int) -> bool:
    """Replica exacta del bloque mesas.py:238-243. Si se extrae a función pura
    debe producir resultados idénticos a esta implementación de referencia."""
    if session is None:
        return False
    items_carrito = int(session.get("items_carrito", 0))
    minutos_desde_scan = int(session.get("minutos_desde_scan", 0))
    return pedidos_activos == 0 and items_carrito == 0 and minutos_desde_scan >= 10


def test_abandonada_sin_sesion_es_false():
    assert _es_abandonada(None, 0) is False


def test_abandonada_con_sesion_vieja_sin_actividad():
    session = {"items_carrito": 0, "minutos_desde_scan": 15}
    assert _es_abandonada(session, pedidos_activos=0) is True


def test_abandonada_con_pedidos_activos_no_es_abandonada():
    session = {"items_carrito": 0, "minutos_desde_scan": 20}
    assert _es_abandonada(session, pedidos_activos=1) is False


def test_abandonada_con_items_carrito_no_es_abandonada():
    session = {"items_carrito": 2, "minutos_desde_scan": 20}
    assert _es_abandonada(session, pedidos_activos=0) is False


def test_abandonada_con_menos_de_10_minutos_no_es_abandonada():
    session = {"items_carrito": 0, "minutos_desde_scan": 9}
    assert _es_abandonada(session, pedidos_activos=0) is False


# ── 6. TRANSICION_ESTADO — contrato de estados ───────────────────────────────

def test_transicion_estado_cubre_flujo_completo():
    from app.routes.pedidos import TRANSICION_ESTADO
    assert TRANSICION_ESTADO == {
        "pendiente": "confirmado",
        "confirmado": "en_preparacion",
        "en_preparacion": "listo",
        "listo": "entregado",
    }


def test_transicion_estado_entregado_no_tiene_siguiente():
    from app.routes.pedidos import TRANSICION_ESTADO
    assert "entregado" not in TRANSICION_ESTADO


# ── 7. _snapshot — estructura del mensaje WS de mesa ─────────────────────────

def test_snapshot_mensaje_contiene_campos_requeridos(monkeypatch):
    """El mensaje _snapshot() enviado a clientes WS debe tener estos campos.
    Cualquier cambio en la estructura rompe los clientes frontend."""
    import app.services.mesa_sessions as mod
    monkeypatch.setattr(mod, "persist_session_snapshot", lambda *_a, **_k: None)

    from app.services.mesa_sessions import MesaSessionManager
    mgr = MesaSessionManager()
    key = "3:tok"
    mgr.sessions[key] = {
        "mesa": 3,
        "host_client_id": "c1",
        "clients": {"c1": {"nombre": "Ana", "websocket": None}},
        "carrito": [{"id_producto": 1, "cantidad": 1, "precio": 100}],
        "observaciones": "sin sal",
        "created_at": datetime.now(timezone.utc),
        "last_activity_at": datetime.now(timezone.utc),
    }

    snap = mgr._snapshot(key)
    assert snap["type"] == "snapshot"
    assert snap["mesa"] == 3
    assert snap["host_client_id"] == "c1"
    assert isinstance(snap["participantes"], list)
    assert snap["carrito"] == [{"id_producto": 1, "cantidad": 1, "precio": 100}]
    assert snap["observaciones"] == "sin sal"
