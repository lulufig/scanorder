"""
Servicio de email para ScanOrder.
Usa smtplib (stdlib) + Gmail SMTP con App Password.

Variables de entorno requeridas:
  GMAIL_USER          — dirección Gmail del remitente
  GMAIL_APP_PASSWORD  — App Password de Google (no la contraseña normal)
  FRONTEND_URL        — URL base del frontend (para links en los emails)

Si GMAIL_USER o GMAIL_APP_PASSWORD no están configuradas, los envíos se
loguean como WARNING y se descartan silenciosamente (el backend sigue funcionando).
"""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def _cfg() -> tuple[str, str, str]:
    """Retorna (gmail_user, app_password, frontend_url) desde el entorno."""
    return (
        os.getenv("GMAIL_USER", ""),
        os.getenv("GMAIL_APP_PASSWORD", ""),
        os.getenv("FRONTEND_URL", "http://localhost:5500"),
    )


def _enviar(to: str, subject: str, body: str) -> None:
    gmail_user, app_password, _ = _cfg()
    if not gmail_user or not app_password:
        logger.warning("Email no configurado — descartando mensaje para %s: %s", to, subject)
        return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = gmail_user
        msg["To"] = to
        msg.attach(MIMEText(body, "plain", "utf-8"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(gmail_user, app_password)
            server.sendmail(gmail_user, to, msg.as_string())
    except Exception as exc:
        logger.warning("Error enviando email a %s: %s", to, exc)


def enviar_bienvenida(email: str, nombre: str, password_temporal: str) -> None:
    _, _, frontend_url = _cfg()
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
    _, _, frontend_url = _cfg()
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
