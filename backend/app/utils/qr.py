import qrcode
import os
import socket
from pathlib import Path
from urllib.parse import urlparse, urlunparse

# Ruta absoluta a backend/static/qr/ derivada desde la ubicación de este archivo
QR_DIR = Path(__file__).resolve().parent.parent.parent / "static" / "qr"


def get_lan_ip() -> str | None:
    """Obtiene la IP LAN actual para que los QR funcionen desde celulares en la misma red."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def get_menu_url() -> str:
    menu_url = os.getenv("MENU_URL", "http://localhost:5500/frontend/cliente/menu.html")
    parsed = urlparse(menu_url)
    lan_ip = get_lan_ip()

    if lan_ip and parsed.hostname and parsed.hostname.startswith(("192.168.", "10.", "172.")):
        netloc = lan_ip
        if parsed.port:
            netloc = f"{lan_ip}:{parsed.port}"
        return urlunparse((parsed.scheme, netloc, parsed.path, "", "", ""))

    return menu_url


def generate_qr(mesa_id: int, mesa_numero: int, token: str | None = None) -> str:
    """
    Genera un código QR para la mesa indicada y lo guarda como PNG.
    Crea el directorio si no existe.
    Retorna la URL relativa accesible desde el frontend: /static/qr/mesa_{id}.png
    """
    QR_DIR.mkdir(parents=True, exist_ok=True)

    menu_url = get_menu_url()
    url_menu = f"{menu_url}?mesa={mesa_numero}"
    if token:
        url_menu = f"{url_menu}&token={token}"

    imagen_qr = qrcode.make(url_menu)

    nombre_archivo = f"mesa_{mesa_id}.png"
    ruta_archivo = QR_DIR / nombre_archivo
    imagen_qr.save(str(ruta_archivo))

    return f"/static/qr/{nombre_archivo}"
