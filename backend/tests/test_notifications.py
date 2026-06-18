"""
Tests de la capa de notificaciones.
El cliente Twilio se mockea via sys.modules: no se envían mensajes reales
y no se requiere tener twilio instalado para correr la suite.
"""
import importlib
import os
import sys
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_twilio_sys_modules(client_cls=None):
    """Devuelve un par (mock_twilio, mock_rest) listo para inyectar en sys.modules."""
    mock_rest = MagicMock()
    if client_cls is not None:
        mock_rest.Client = client_cls
    mock_twilio = MagicMock()
    mock_twilio.rest = mock_rest
    return mock_twilio, mock_rest


def _load_notifications(env_overrides: dict, sys_modules_extra: dict | None = None):
    """
    Recarga app.services.notifications con vars de entorno y sys.modules controlados.
    Limpia el módulo del cache antes de importar para que _build_notifier() re-evalúe.
    """
    mod_name = "app.services.notifications"
    for key in list(sys.modules):
        if key == mod_name:
            del sys.modules[key]

    extra = sys_modules_extra or {}
    with patch.dict(os.environ, env_overrides, clear=False):
        with patch.dict(sys.modules, extra):
            return importlib.import_module(mod_name)


def _make_notifier_with_mock_twilio(mock_client_cls):
    """
    Instancia TwilioWhatsAppNotifier con el módulo twilio completamente mockeado.
    La instanciación ocurre dentro del patch.dict para que el import lazy
    `from twilio.rest import Client` encuentre el mock en sys.modules.
    """
    mock_twilio, mock_rest = _make_twilio_sys_modules(mock_client_cls)
    mod_name = "app.services.notifications"
    for key in list(sys.modules):
        if key == mod_name:
            del sys.modules[key]
    # mantener el contexto activo durante import Y __init__
    with patch.dict(sys.modules, {"twilio": mock_twilio, "twilio.rest": mock_rest}):
        mod = importlib.import_module(mod_name)
        notifier = mod.TwilioWhatsAppNotifier(
            account_sid="AC_test",
            auth_token="auth_test",
            from_="whatsapp:+14155238886",
            to="whatsapp:+5491100000000",
        )
    # después del with: notifier._client ya referencia mock_instance
    return notifier


# ---------------------------------------------------------------------------
# TwilioWhatsAppNotifier — mensajes generados correctamente
# ---------------------------------------------------------------------------

class TestTwilioWhatsAppNotifier:
    def test_pedido_creado_incluye_mesa_y_total(self):
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        notifier.notify({"type": "pedido_creado", "numero_mesa": 3, "total": 1250.5})

        mock_instance.messages.create.assert_called_once()
        body = mock_instance.messages.create.call_args.kwargs["body"]
        assert "Mesa 3" in body
        assert "1250.50" in body

    def test_pedido_creado_sin_total_no_falla(self):
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        notifier.notify({"type": "pedido_creado", "numero_mesa": 5})

        body = mock_instance.messages.create.call_args.kwargs["body"]
        assert "Mesa 5" in body

    def test_servicio_mozo(self):
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        notifier.notify({"type": "servicio_mesa", "tipo": "mozo", "numero_mesa": 7})

        body = mock_instance.messages.create.call_args.kwargs["body"]
        assert "Mesa 7" in body
        assert "mozo" in body

    def test_servicio_cuenta(self):
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        notifier.notify({"type": "servicio_mesa", "tipo": "cuenta", "numero_mesa": 2})

        body = mock_instance.messages.create.call_args.kwargs["body"]
        assert "Mesa 2" in body
        assert "cuenta" in body

    def test_from_y_to_se_pasan_correctamente(self):
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        notifier.notify({"type": "pedido_creado", "numero_mesa": 1, "total": 500})

        kwargs = mock_instance.messages.create.call_args.kwargs
        assert kwargs["from_"] == "whatsapp:+14155238886"
        assert kwargs["to"] == "whatsapp:+5491100000000"

    def test_fallo_de_twilio_se_propaga_como_excepcion(self):
        """El notifier NO silencia errores — eso es responsabilidad del caller en pedidos.py."""
        mock_client_cls = MagicMock()
        mock_instance = MagicMock()
        mock_instance.messages.create.side_effect = Exception("Twilio 500")
        mock_client_cls.return_value = mock_instance

        notifier = _make_notifier_with_mock_twilio(mock_client_cls)
        with pytest.raises(Exception, match="Twilio 500"):
            notifier.notify({"type": "pedido_creado", "numero_mesa": 1, "total": 100})


# ---------------------------------------------------------------------------
# Singleton _build_notifier — selección según env vars
# ---------------------------------------------------------------------------

TWILIO_ENV = {
    "TWILIO_ACCOUNT_SID": "AC_test",
    "TWILIO_AUTH_TOKEN": "tok_test",
    "TWILIO_WHATSAPP_FROM": "whatsapp:+14155238886",
    "TWILIO_WHATSAPP_TO": "whatsapp:+5491100000000",
}

TWILIO_ENV_EMPTY = {k: "" for k in TWILIO_ENV}


class TestBuildNotifier:
    def test_sin_vars_devuelve_null_notifier(self):
        mod = _load_notifications(TWILIO_ENV_EMPTY)
        assert type(mod.notification_service).__name__ == "_NullNotifier"

    def test_con_vars_completas_devuelve_twilio_notifier(self):
        mock_twilio, mock_rest = _make_twilio_sys_modules()
        mod = _load_notifications(
            TWILIO_ENV,
            {"twilio": mock_twilio, "twilio.rest": mock_rest},
        )
        assert type(mod.notification_service).__name__ == "TwilioWhatsAppNotifier"

    def test_twilio_no_instalado_devuelve_null_notifier(self):
        """Si twilio no está en el entorno, se degrada a NullNotifier sin romper el arranque."""
        mod = _load_notifications(
            TWILIO_ENV,
            {"twilio": None, "twilio.rest": None},
        )
        assert type(mod.notification_service).__name__ == "_NullNotifier"

    def test_vars_parciales_devuelve_null_notifier(self):
        """Faltan algunas vars → no intenta crear TwilioWhatsAppNotifier."""
        partial = {
            "TWILIO_ACCOUNT_SID": "AC_test",
            "TWILIO_AUTH_TOKEN": "",
            "TWILIO_WHATSAPP_FROM": "",
            "TWILIO_WHATSAPP_TO": "",
        }
        mod = _load_notifications(partial)
        assert type(mod.notification_service).__name__ == "_NullNotifier"


# ---------------------------------------------------------------------------
# _NullNotifier — no hace nada, no lanza
# ---------------------------------------------------------------------------

class TestNullNotifier:
    def test_notify_no_lanza(self):
        mod = _load_notifications(TWILIO_ENV_EMPTY)
        mod.notification_service.notify({"type": "pedido_creado", "numero_mesa": 1})

    def test_notify_acepta_evento_vacio(self):
        mod = _load_notifications(TWILIO_ENV_EMPTY)
        mod.notification_service.notify({})


# ---------------------------------------------------------------------------
# EscPosPrinterNotifier — stub lanza NotImplementedError
# ---------------------------------------------------------------------------

class TestEscPosPrinterNotifier:
    def test_notify_lanza_not_implemented(self):
        mod = _load_notifications(TWILIO_ENV_EMPTY)
        printer = mod.EscPosPrinterNotifier()
        with pytest.raises(NotImplementedError):
            printer.notify({"type": "pedido_creado", "numero_mesa": 1})
