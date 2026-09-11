"""
Regenera el PNG de QR de todas las mesas usando la MENU_URL actual del .env.

No cambia `qr_token` de ninguna mesa: solo redibuja la imagen con la URL
nueva, así los QR ya impresos (si los hubiera) siguen siendo válidos en
cuanto a autenticación — únicamente cambia el dominio embebido.

Uso (desde backend/, con el venv activado):
    python scripts/regenerar_qrs.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_db_connection, close_db_connection
from app.utils.qr import generate_qr, get_menu_url

conn = get_db_connection()
cur = conn.cursor(dictionary=True)
cur.execute("SELECT id_mesa, numero, qr_token FROM mesas ORDER BY numero")
mesas = cur.fetchall()

if not mesas:
    print("No hay mesas cargadas.")
else:
    print(f"MENU_URL actual: {get_menu_url()}\n")
    for m in mesas:
        generate_qr(m["id_mesa"], m["numero"], m.get("qr_token"))
        print(f"  Mesa {m['numero']} (id {m['id_mesa']}): regenerada")
    print(f"\n{len(mesas)} QR regenerados. Descargalos desde el panel 'QR Mesas' del admin.")

cur.close()
close_db_connection(conn)
