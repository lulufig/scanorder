"""
Abstracción de notificaciones externas para eventos de pedidos.

Interfaz: NotificationService.notify(evento: dict) -> None
  evento siempre incluye al menos:
    - "type": "pedido_creado" | "servicio_mesa"
    - "numero_mesa": int

Implementaciones disponibles:
  - TwilioWhatsAppNotifier  — activa si las 4 vars de entorno Twilio están presentes
  - EscPosPrinterNotifier   — stub; TODO cuando se conecte la impresora térmica
  - _NullNotifier           — fallback silencioso (vars no configuradas o error de init)

Para agregar la impresora térmica:
  1. Implementar EscPosPrinterNotifier (ver TODO abajo).
  2. En _build_notifier(), agregar la rama que lo instancia según sus vars de entorno.
  3. Si se quieren múltiples destinos simultáneos, reemplazar el singleton por una lista
     de notifiers y disparar todos desde un CompositeNotifier.
"""
import logging
import os
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class NotificationService(ABC):
    @abstractmethod
    def notify(self, evento: dict) -> None: ...


class TwilioWhatsAppNotifier(NotificationService):
    """
    Envía mensajes WhatsApp via Twilio.

    Vars de entorno requeridas:
      TWILIO_ACCOUNT_SID   — SID de la cuenta Twilio
      TWILIO_AUTH_TOKEN    — token de autenticación
      TWILIO_WHATSAPP_FROM — número origen en formato "whatsapp:+XXXXXXXXXXX"
      TWILIO_WHATSAPP_TO   — número del restaurante en formato "whatsapp:+XXXXXXXXXXX"
    """

    def __init__(self, account_sid: str, auth_token: str, from_: str, to: str):
        from twilio.rest import Client  # import lazy: no falla si twilio no está instalado
        self._client = Client(account_sid, auth_token)
        self._from = from_
        self._to = to

    def notify(self, evento: dict) -> None:
        tipo = evento.get("type")
        mesa = evento.get("numero_mesa", "?")

        if tipo == "pedido_creado":
            total = evento.get("total")
            body = f"Nuevo pedido — Mesa {mesa}"
            if total is not None:
                body += f" — ${float(total):.2f}"
        elif tipo == "servicio_mesa":
            subtipo = evento.get("tipo", "")
            accion = "mozo" if subtipo == "mozo" else "la cuenta"
            body = f"Mesa {mesa} solicita {accion}"
        else:
            body = evento.get("message", str(evento))

        self._client.messages.create(body=body, from_=self._from, to=self._to)


class EscPosPrinterNotifier(NotificationService):
    """
    TODO: implementar cuando se agregue la impresora térmica ESC/POS.

    Pasos sugeridos:
      1. Agregar var de entorno PRINTER_TARGET (ej. "/dev/usb/lp0" o "192.168.1.50:9100").
      2. Elegir librería: python-escpos (USB/serial/red) o escpos (más liviana).
      3. En notify(), formatear un ticket compacto con numero_mesa, tipo de evento y hora.
      4. Instanciar en _build_notifier() si PRINTER_TARGET está presente.
    """

    def notify(self, evento: dict) -> None:
        raise NotImplementedError("EscPosPrinterNotifier no implementado aún")


class _NullNotifier(NotificationService):
    """Implementación vacía usada cuando Twilio no está configurado."""

    def notify(self, evento: dict) -> None:
        pass


def _build_notifier() -> NotificationService:
    sid = os.getenv("TWILIO_ACCOUNT_SID")
    token = os.getenv("TWILIO_AUTH_TOKEN")
    from_ = os.getenv("TWILIO_WHATSAPP_FROM")
    to = os.getenv("TWILIO_WHATSAPP_TO")

    if sid and token and from_ and to:
        try:
            notifier = TwilioWhatsAppNotifier(sid, token, from_, to)
            logger.info("NotificationService: TwilioWhatsAppNotifier activo → %s", to)
            return notifier
        except Exception as exc:
            logger.warning(
                "NotificationService: no se pudo inicializar Twilio (%s) — usando NullNotifier",
                exc,
            )

    logger.debug("NotificationService: usando NullNotifier (Twilio no configurado)")
    return _NullNotifier()


notification_service: NotificationService = _build_notifier()
