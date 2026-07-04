"""
Servicio de email para ScanOrder.
Usa smtplib (stdlib) contra un relay SMTP de un proveedor transaccional
(Brevo, SendGrid, Mailgun, etc.) en vez de un Gmail personal: un Gmail
personal enviando por script puede ser bloqueado en silencio por los
filtros antiabuso de Google hacia destinatarios sin historial previo con
el remitente, sin generar rebote ni caer en spam (queda indetectable).

Variables de entorno requeridas:
  SMTP_HOST      — host del relay SMTP del proveedor (ej. smtp-relay.brevo.com)
  SMTP_PORT      — puerto SMTP, típicamente 587 (STARTTLS)
  SMTP_USER      — usuario/login SMTP que da el proveedor
  SMTP_PASSWORD  — contraseña/API key SMTP que da el proveedor
  EMAIL_FROM     — dirección remitente que verá el destinatario (debe estar
                   verificada en el proveedor); si no se define, se usa SMTP_USER
  FRONTEND_URL   — URL base del frontend (para links en los emails)

Si SMTP_HOST, SMTP_USER o SMTP_PASSWORD no están configuradas, los envíos se
loguean como WARNING y se descartan silenciosamente (el backend sigue funcionando).
"""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def _cfg() -> tuple[str, int, str, str, str, str]:
    """Retorna (host, port, user, password, from_addr, frontend_url) desde el entorno."""
    user = os.getenv("SMTP_USER", "")
    return (
        os.getenv("SMTP_HOST", ""),
        int(os.getenv("SMTP_PORT", "587")),
        user,
        os.getenv("SMTP_PASSWORD", ""),
        os.getenv("EMAIL_FROM", "") or user,
        os.getenv("FRONTEND_URL", "http://localhost:5500"),
    )


def _enviar(to: str, subject: str, body: str) -> None:
    host, port, user, password, from_addr, _ = _cfg()
    if not host or not user or not password:
        logger.warning("Email no configurado — descartando mensaje para %s: %s", to, subject)
        return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = to
        msg.attach(MIMEText(body, "plain", "utf-8"))

        with smtplib.SMTP(host, port) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(from_addr, to, msg.as_string())
    except Exception as exc:
        logger.warning("Error enviando email a %s: %s", to, exc)


def enviar_bienvenida(email: str, nombre: str, password_temporal: str) -> None:
    *_, frontend_url = _cfg()
    subject = "Tu cuenta en ScanOrder fue creada"
    body = (
        f"Hola {nombre},\n\n"
        "Tu cuenta en ScanOrder fue creada por el administrador.\n\n"
        f"Tu contraseña temporal es: {password_temporal}\n\n"
        "Por seguridad, deberás cambiarla en tu próximo inicio de sesión.\n\n"
        f"Podés ingresar en: {frontend_url}/frontend/auth/login.html\n\n"
        "ScanOrder — Maven Burger"
    )
    _enviar(email, subject, body)


def enviar_reset_password(email: str, nombre: str, token: str) -> None:
    *_, frontend_url = _cfg()
    reset_url = f"{frontend_url}/frontend/reset-password.html?token={token}"
    subject = "Reseteo de contraseña — ScanOrder"
    body = (
        f"Hola {nombre},\n\n"
        "Recibimos una solicitud para resetear tu contraseña.\n\n"
        f"Hacé clic en el siguiente link (válido por 30 minutos):\n{reset_url}\n\n"
        "Si no solicitaste este cambio, podés ignorar este email.\n\n"
        "ScanOrder — Maven Burger"
    )
    _enviar(email, subject, body)
