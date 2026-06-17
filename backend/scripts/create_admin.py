"""
Script de primer arranque: crea el usuario admin inicial si no existe ningún usuario.
Imprime las credenciales generadas en stdout para que el operador las vea en los logs.
"""
import os
import secrets
import sys

# Asegurar que el path del proyecto esté disponible
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import get_db_connection, close_db_connection
from app.utils.security import hash_password

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@scanorder.local")
ADMIN_NOMBRE = os.environ.get("ADMIN_NOMBRE", "Administrador")


def main():
    connection = get_db_connection()
    if not connection:
        print("[create_admin] ERROR: no se pudo conectar a la base de datos", flush=True)
        sys.exit(1)

    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute("SELECT COUNT(*) AS total FROM usuarios")
        total = cursor.fetchone()["total"]

        if total > 0:
            print(f"[create_admin] Ya existen {total} usuario(s) — no se crea el admin.", flush=True)
            return

        password = secrets.token_urlsafe(16)
        cursor.execute(
            """
            INSERT INTO usuarios (nombre, email, password_hash, rol, activo, must_change_password)
            VALUES (%s, %s, %s, 'admin', TRUE, TRUE)
            """,
            (ADMIN_NOMBRE, ADMIN_EMAIL, hash_password(password)),
        )
        connection.commit()

        print("", flush=True)
        print("=" * 60, flush=True)
        print("  USUARIO ADMIN CREADO", flush=True)
        print(f"  Email:      {ADMIN_EMAIL}", flush=True)
        print(f"  Contraseña: {password}", flush=True)
        print("  IMPORTANTE: cambiá la contraseña en el primer login.", flush=True)
        print("=" * 60, flush=True)
        print("", flush=True)

    except Exception as e:
        connection.rollback()
        print(f"[create_admin] ERROR: {e}", flush=True)
        sys.exit(1)
    finally:
        cursor.close()
        close_db_connection(connection)


if __name__ == "__main__":
    main()
