"""
Tests de permisos para el refactor refactor/roles-mozo.

Verifican:
 - PATCH /pedidos/{id}/estado: mozo y admin pasan el check de rol; "cocina" es rechazado.
 - POST /mesas/{id}/cerrar: mozo y admin pasan el check de rol; "cocina" es rechazado.
 - POST /mesas/{id}/atender-mozo: ídem.
 - WS /pedidos/ws/cocina: acepta COCINA_DEVICE_TOKEN correcto; rechaza 1008 el resto.

No requieren MySQL: los checks de rol se evalúan ANTES de abrir conexión a la DB.
Cuando el rol es válido el endpoint intenta la DB y devuelve 404/500 (no 403).
Cuando el rol es inválido FastAPI devuelve 403 antes de tocar la DB.
"""
import os
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.utils.security import create_access_token


# ── Helpers ───────────────────────────────────────────────────────────────────

def _token(rol: str) -> str:
    return create_access_token({"user_id": 99, "email": f"{rol}@test.com", "rol": rol})


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


# ── PATCH /pedidos/{id}/estado ────────────────────────────────────────────────

class TestPatchEstadoRoles:
    """El check de rol es manual (antes de abrir DB), por eso mozo/admin llegan
    hasta el intento de conexión a DB (500) y "cocina" corta en 403."""

    def test_mozo_pasa_check_de_rol(self, client):
        resp = client.patch(
            "/pedidos/999999/estado",
            json={"estado": "confirmado"},
            headers={"Authorization": f"Bearer {_token('mozo')}"},
        )
        assert resp.status_code != 403

    def test_admin_pasa_check_de_rol(self, client):
        resp = client.patch(
            "/pedidos/999999/estado",
            json={"estado": "confirmado"},
            headers={"Authorization": f"Bearer {_token('admin')}"},
        )
        assert resp.status_code != 403

    def test_cocina_rechazado_403(self, client):
        resp = client.patch(
            "/pedidos/999999/estado",
            json={"estado": "confirmado"},
            headers={"Authorization": f"Bearer {_token('cocina')}"},
        )
        assert resp.status_code == 403

    def test_sin_auth_rechazado(self, client):
        resp = client.patch(
            "/pedidos/999999/estado",
            json={"estado": "confirmado"},
        )
        assert resp.status_code in {401, 403}


class TestPatchEstadoDeviceToken:
    """El panel de cocina (COCINA_DEVICE_TOKEN) puede avanzar el pedido hasta
    'listo', pero nunca marcar 'entregado' (eso descuenta stock, lo hace el mozo)."""

    DEVICE = "device-secret-test-abc123"

    def test_device_token_puede_marcar_listo(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", self.DEVICE)
        resp = client.patch(
            f"/pedidos/999999/estado?device_token={self.DEVICE}",
            json={"estado": "listo"},
        )
        # Pasa el check de auth; corta en 404 porque el pedido no existe.
        assert resp.status_code != 403

    def test_device_token_no_puede_marcar_entregado(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", self.DEVICE)
        resp = client.patch(
            f"/pedidos/999999/estado?device_token={self.DEVICE}",
            json={"estado": "entregado"},
        )
        assert resp.status_code == 403

    def test_device_token_invalido_rechazado(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", self.DEVICE)
        resp = client.patch(
            "/pedidos/999999/estado?device_token=token-incorrecto",
            json={"estado": "listo"},
        )
        assert resp.status_code in {401, 403}

    def test_sin_env_var_el_device_token_no_sirve(self, client, monkeypatch):
        monkeypatch.delenv("COCINA_DEVICE_TOKEN", raising=False)
        resp = client.patch(
            f"/pedidos/999999/estado?device_token={self.DEVICE}",
            json={"estado": "listo"},
        )
        assert resp.status_code in {401, 403}


# ── POST /mesas/{id}/cerrar ───────────────────────────────────────────────────

class TestCerrarMesaRoles:
    """require_role("mozo", "admin") evalúa el dep ANTES de llamar la función."""

    def test_mozo_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 100.0},
            headers={"Authorization": f"Bearer {_token('mozo')}"},
        )
        assert resp.status_code != 403

    def test_admin_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 100.0},
            headers={"Authorization": f"Bearer {_token('admin')}"},
        )
        assert resp.status_code != 403

    def test_cocina_rechazado_403(self, client):
        resp = client.post(
            "/mesas/999999/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 100.0},
            headers={"Authorization": f"Bearer {_token('cocina')}"},
        )
        assert resp.status_code == 403

    def test_sin_auth_rechazado(self, client):
        resp = client.post(
            "/mesas/999999/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 100.0},
        )
        assert resp.status_code in {401, 403}


# ── POST /mesas/{id}/atender-mozo ────────────────────────────────────────────

class TestAtenderMozoRoles:
    def test_mozo_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/atender-mozo",
            headers={"Authorization": f"Bearer {_token('mozo')}"},
        )
        assert resp.status_code != 403

    def test_admin_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/atender-mozo",
            headers={"Authorization": f"Bearer {_token('admin')}"},
        )
        assert resp.status_code != 403

    def test_cocina_rechazado_403(self, client):
        resp = client.post(
            "/mesas/999999/atender-mozo",
            headers={"Authorization": f"Bearer {_token('cocina')}"},
        )
        assert resp.status_code == 403


# ── POST /mesas/{id}/tomar-llamado ───────────────────────────────────────────

class TestTomarLlamadoRoles:
    def test_mozo_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/tomar-llamado",
            headers={"Authorization": f"Bearer {_token('mozo')}"},
        )
        assert resp.status_code != 403

    def test_admin_pasa_check_de_rol(self, client):
        resp = client.post(
            "/mesas/999999/tomar-llamado",
            headers={"Authorization": f"Bearer {_token('admin')}"},
        )
        assert resp.status_code != 403

    def test_cocina_rechazado_403(self, client):
        resp = client.post(
            "/mesas/999999/tomar-llamado",
            headers={"Authorization": f"Bearer {_token('cocina')}"},
        )
        assert resp.status_code == 403

    def test_sin_auth_rechazado(self, client):
        resp = client.post("/mesas/999999/tomar-llamado")
        assert resp.status_code in {401, 403}


# ── WS /pedidos/ws/cocina ─────────────────────────────────────────────────────

DEVICE_SECRET = "device-secret-test-abc123"


class TestWsCocinaDeviceToken:
    """El handler cierra con 1008 antes de accept() cuando el token no coincide.
    Starlette TestClient propaga eso como WebSocketDisconnect(code=1008)."""

    def test_token_correcto_conecta(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", DEVICE_SECRET)
        with client.websocket_connect(
            f"/pedidos/ws/cocina?device_token={DEVICE_SECRET}"
        ):
            pass  # conexión establecida; cierre limpio al salir del with

    def test_token_incorrecto_rechazado_1008(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", DEVICE_SECRET)
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                "/pedidos/ws/cocina?device_token=token-incorrecto"
            ) as ws:
                ws.receive_text()
        assert exc.value.code == 1008

    def test_sin_token_rechazado_1008(self, client, monkeypatch):
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", DEVICE_SECRET)
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/pedidos/ws/cocina") as ws:
                ws.receive_text()
        assert exc.value.code == 1008

    def test_sin_env_var_rechaza_cualquier_token(self, client, monkeypatch):
        monkeypatch.delenv("COCINA_DEVICE_TOKEN", raising=False)
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                f"/pedidos/ws/cocina?device_token={DEVICE_SECRET}"
            ) as ws:
                ws.receive_text()
        assert exc.value.code == 1008

    def test_jwt_anterior_ya_no_funciona(self, client, monkeypatch):
        """Un JWT de cocina o admin ya NO sirve para el WS de cocina."""
        monkeypatch.setenv("COCINA_DEVICE_TOKEN", DEVICE_SECRET)
        jwt_admin = _token("admin")
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                f"/pedidos/ws/cocina?device_token={jwt_admin}"
            ) as ws:
                ws.receive_text()
        assert exc.value.code == 1008


# ── require_role variadic ─────────────────────────────────────────────────────

class TestRequireRoleVariadic:
    """require_role ahora acepta múltiples roles."""

    def test_require_role_unico_sigue_funcionando(self, client):
        resp = client.get(
            "/auth/admin-only",
            headers={"Authorization": f"Bearer {_token('admin')}"},
        )
        assert resp.status_code == 200

    def test_require_role_unico_rechaza_otro_rol(self, client):
        resp = client.get(
            "/auth/admin-only",
            headers={"Authorization": f"Bearer {_token('mozo')}"},
        )
        assert resp.status_code == 403

    def test_ambos_roles_pasan_en_endpoint_multiple(self, client):
        """POST /mesas/{id}/atender-mozo acepta tanto mozo como admin."""
        for rol in ("mozo", "admin"):
            resp = client.post(
                "/mesas/999999/atender-mozo",
                headers={"Authorization": f"Bearer {_token(rol)}"},
            )
            assert resp.status_code != 403, f"Rol {rol!r} fue rechazado inesperadamente"


# ── ROLES_VALIDOS en schema ───────────────────────────────────────────────────

def test_roles_validos_contiene_mozo_y_no_cocina():
    from app.schemas.auth import ROLES_VALIDOS
    assert "mozo" in ROLES_VALIDOS
    assert "cocina" not in ROLES_VALIDOS
    assert "admin" in ROLES_VALIDOS


def test_userregister_default_es_mozo():
    from app.schemas.auth import UserRegister
    u = UserRegister(nombre="X", email="x@x.com", password="12345678")
    assert u.rol == "mozo"


def test_userregister_rechaza_rol_cocina():
    from app.schemas.auth import UserRegister
    with pytest.raises(Exception, match="cocina"):
        UserRegister(nombre="X", email="x@x.com", password="12345678", rol="cocina")
