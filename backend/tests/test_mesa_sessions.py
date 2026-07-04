"""
Tests de unidad para MesaSessionManager (app/services/mesa_sessions.py):
el carrito colaborativo host/guest por mesa.

persist_session_snapshot() / delete_session_snapshot() se mockean porque
tocan MySQL real (best-effort, ver docstring de mesa_state_repo.py) — estos
tests verifican la lógica en memoria, no la persistencia. cocina_manager.broadcast()
no se mockea: con `active_connections` vacío es un no-op puro en memoria.

No requieren MySQL. Cada test crea su propia instancia de MesaSessionManager
(no el singleton `mesa_sessions`) para no compartir estado entre tests.
"""
import asyncio
from unittest.mock import patch

import pytest

from app.services.mesa_sessions import MesaSessionManager


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.sent: list[dict] = []
        self.raise_on_send = False

    async def accept(self):
        self.accepted = True

    async def send_json(self, data):
        if self.raise_on_send:
            raise RuntimeError("conexión cerrada")
        self.sent.append(data)


@pytest.fixture
def manager():
    return MesaSessionManager()


def _run(coro):
    return asyncio.run(coro)


# ── session_key ────────────────────────────────────────────────────────────────

class TestSessionKey:
    def test_combina_mesa_y_token(self, manager):
        assert manager.session_key(5, "abc123") == "5:abc123"

    def test_token_none_usa_string_vacio(self, manager):
        assert manager.session_key(5, None) == "5:"


# ── connect ──────────────────────────────────────────────────────────────────

@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestConnect:
    def test_primer_cliente_es_host(self, mock_persist, manager):
        ws = FakeWebSocket()
        _run(manager.connect(ws, "1:tok", 1, "client-a", "Ana"))

        session = manager.get_session("1:tok")
        assert ws.accepted is True
        assert session["host_client_id"] == "client-a"
        assert "client-a" in session["clients"]
        mock_persist.assert_called_once()

    def test_segundo_cliente_no_reemplaza_al_host(self, mock_persist, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-b", "Beto"))

        session = manager.get_session("1:tok")
        assert session["host_client_id"] == "client-a"
        assert set(session["clients"].keys()) == {"client-a", "client-b"}

    def test_primer_cliente_recibe_snapshot_inicial(self, mock_persist, manager):
        ws = FakeWebSocket()
        _run(manager.connect(ws, "1:tok", 1, "client-a", "Ana"))

        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "snapshot"
        assert ws.sent[0]["host_client_id"] == "client-a"

    def test_segundo_cliente_dispara_broadcast_a_los_demas(self, mock_persist, manager):
        ws_a = FakeWebSocket()
        ws_b = FakeWebSocket()
        _run(manager.connect(ws_a, "1:tok", 1, "client-a", "Ana"))
        _run(manager.connect(ws_b, "1:tok", 1, "client-b", "Beto"))

        # ws_a recibe el snapshot inicial + el aviso de "participantes_actualizados"
        # cuando se conecta client-b (exclude=client-b, así que a client-a sí le llega).
        tipos_recibidos_por_a = [msg["type"] for msg in ws_a.sent]
        assert "participantes_actualizados" in tipos_recibidos_por_a
        # ws_b solo recibe su propio snapshot inicial (fue excluido del broadcast).
        assert [msg["type"] for msg in ws_b.sent] == ["snapshot"]

    def test_nombre_vacio_usa_default_cliente(self, mock_persist, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", ""))
        session = manager.get_session("1:tok")
        assert session["clients"]["client-a"]["nombre"] == "Cliente"


# ── disconnect ───────────────────────────────────────────────────────────────

@patch("app.services.mesa_sessions.delete_session_snapshot")
@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestDisconnect:
    def test_host_se_reasigna_a_otro_participante(self, mock_persist, mock_delete, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-b", "Beto"))

        manager.disconnect("1:tok", "client-a")

        session = manager.get_session("1:tok")
        assert session["host_client_id"] == "client-b"
        assert "client-a" not in session["clients"]
        mock_delete.assert_not_called()

    def test_ultimo_cliente_con_carrito_vacio_elimina_la_sesion(self, mock_persist, mock_delete, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))

        manager.disconnect("1:tok", "client-a")

        assert manager.get_session("1:tok") is None
        mock_delete.assert_called_once_with("1:tok")

    def test_ultimo_cliente_con_carrito_no_vacio_conserva_la_sesion(self, mock_persist, mock_delete, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        manager.sessions["1:tok"]["carrito"] = [{"id_producto": 1, "cantidad": 2, "precio": 100}]

        manager.disconnect("1:tok", "client-a")

        assert manager.get_session("1:tok") is not None
        mock_delete.assert_not_called()

    def test_desconectar_client_id_inexistente_no_rompe(self, mock_persist, mock_delete, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        manager.disconnect("1:tok", "client-fantasma")  # no debe lanzar
        assert manager.get_session("1:tok") is not None

    def test_desconectar_de_sesion_inexistente_no_rompe(self, mock_persist, mock_delete, manager):
        manager.disconnect("no-existe", "client-a")  # no debe lanzar


# ── broadcast (fallo de envío desconecta al cliente) ─────────────────────────

@patch("app.services.mesa_sessions.delete_session_snapshot")
@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestBroadcast:
    def test_cliente_con_send_fallido_se_desconecta(self, mock_persist, mock_delete, manager):
        ws_a = FakeWebSocket()
        ws_b = FakeWebSocket()
        _run(manager.connect(ws_a, "1:tok", 1, "client-a", "Ana"))
        _run(manager.connect(ws_b, "1:tok", 1, "client-b", "Beto"))
        ws_b.raise_on_send = True  # simula la conexión caída recién ahora

        _run(manager.broadcast("1:tok", {"type": "ping"}))

        session = manager.get_session("1:tok")
        assert "client-b" not in session["clients"]
        assert "client-a" in session["clients"]


# ── update_cart / clear_cart ──────────────────────────────────────────────────

@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestUpdateCart:
    def test_actualiza_carrito_y_observaciones(self, mock_persist, manager):
        ws = FakeWebSocket()
        _run(manager.connect(ws, "1:tok", 1, "client-a", "Ana"))
        carrito = [{"id_producto": 1, "cantidad": 2, "precio": 100.0}]

        _run(manager.update_cart("1:tok", carrito, "sin sal"))

        session = manager.get_session("1:tok")
        assert session["carrito"] == carrito
        assert session["observaciones"] == "sin sal"

    def test_observaciones_none_se_normaliza_a_string_vacio(self, mock_persist, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        _run(manager.update_cart("1:tok", [], None))
        assert manager.get_session("1:tok")["observaciones"] == ""

    def test_sesion_inexistente_no_rompe(self, mock_persist, manager):
        _run(manager.update_cart("no-existe", [], None))  # no debe lanzar
        mock_persist.assert_not_called()

    def test_broadcast_carrito_actualizado_llega_a_otros_clientes(self, mock_persist, manager):
        ws_a = FakeWebSocket()
        ws_b = FakeWebSocket()
        _run(manager.connect(ws_a, "1:tok", 1, "client-a", "Ana"))
        _run(manager.connect(ws_b, "1:tok", 1, "client-b", "Beto"))

        _run(manager.update_cart("1:tok", [{"id_producto": 1, "cantidad": 1, "precio": 50}], ""))

        tipos_b = [msg["type"] for msg in ws_b.sent]
        assert "carrito_actualizado" in tipos_b


@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestClearCart:
    def test_vacia_carrito_y_observaciones(self, mock_persist, manager):
        _run(manager.connect(FakeWebSocket(), "1:tok", 1, "client-a", "Ana"))
        _run(manager.update_cart("1:tok", [{"id_producto": 1, "cantidad": 1, "precio": 50}], "obs"))

        _run(manager.clear_cart("1:tok"))

        session = manager.get_session("1:tok")
        assert session["carrito"] == []
        assert session["observaciones"] == ""

    def test_broadcast_pedido_confirmado(self, mock_persist, manager):
        ws = FakeWebSocket()
        _run(manager.connect(ws, "1:tok", 1, "client-a", "Ana"))

        _run(manager.clear_cart("1:tok"))

        assert ws.sent[-1]["type"] == "pedido_confirmado"


# ── force_release ──────────────────────────────────────────────────────────────

@patch("app.services.mesa_sessions.delete_session_snapshot")
@patch("app.services.mesa_sessions.persist_session_snapshot")
class TestForceRelease:
    def test_elimina_todas_las_sesiones_de_la_mesa(self, mock_persist, mock_delete, manager):
        # dos QR distintos para la misma mesa (ej: se regeneró el QR con sesión abierta)
        _run(manager.connect(FakeWebSocket(), "5:tok-viejo", 5, "client-a", "Ana"))
        _run(manager.connect(FakeWebSocket(), "5:tok-nuevo", 5, "client-b", "Beto"))
        _run(manager.connect(FakeWebSocket(), "9:tok-otra", 9, "client-c", "Caro"))

        manager.force_release(5)

        assert manager.get_session("5:tok-viejo") is None
        assert manager.get_session("5:tok-nuevo") is None
        assert manager.get_session("9:tok-otra") is not None
        assert mock_delete.call_count == 2

    def test_mesa_sin_sesiones_no_rompe(self, mock_persist, mock_delete, manager):
        manager.force_release(999)  # no debe lanzar
        mock_delete.assert_not_called()
