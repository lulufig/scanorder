import qrcode
import os
from pathlib import Path

# Ruta absoluta a backend/static/qr/ derivada desde la ubicación de este archivo
QR_DIR = Path(__file__).resolve().parent.parent.parent / "static" / "qr"


def generate_qr(mesa_id: int, token: str | None = None) -> str:
    """
    Genera un código QR para la mesa indicada y lo guarda como PNG.
    Crea el directorio si no existe.
    Retorna la URL relativa accesible desde el frontend: /static/qr/mesa_{id}.png
    """
    QR_DIR.mkdir(parents=True, exist_ok=True)

    menu_url = os.getenv("MENU_URL", "http://localhost:5500/frontend/cliente/menu.html")
    url_menu = f"{menu_url}?mesa={mesa_id}"
    if token:
        url_menu = f"{url_menu}&token={token}"

    imagen_qr = qrcode.make(url_menu)

    nombre_archivo = f"mesa_{mesa_id}.png"
    ruta_archivo = QR_DIR / nombre_archivo
    imagen_qr.save(str(ruta_archivo))

    return f"/static/qr/{nombre_archivo}"
