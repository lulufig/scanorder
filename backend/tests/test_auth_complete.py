"""
Tests para feature/auth-complete.

Cobertura:
  Permisos (no requieren MySQL):
    - GET/POST /admin/usuarios rechaza a no-admin con 403
    - POST /admin/usuarios/{id}/reenviar-bienvenida rechaza a no-admin con 403
    - PUT /admin/usuarios/{id} rechaza a no-admin con 403
    - POST /auth/cambiar-password rechaza sin token con 403

  Rate limit (no requiere MySQL, estado en memoria):
    - forgot-password devuelve 429 al 4° intento con el mismo email
    - forgot-password resetea contador por email (emails distintos no se bloquean entre sí)

  Unidad — email_service (SMTP mockeado, sin red):
    - enviar_bienvenida llama al relay SMTP con las credenciales configuradas
    - enviar_bienvenida descarta silenciosamente si SMTP_HOST no está configurado
    - enviar_reset_password construye la URL con el token

  Integración (requieren MySQL — saltan si DB_HOST no está en el entorno):
    - Admin crea usuario → existe en DB con must_change_password=True
    - GET /admin/usuarios lista usuarios sin campo password_hash
    - PUT /admin/usuarios/{id} con nombre/email/rol → cambios persisten en DB
    - PUT /admin/usuarios/{id} con email ya usado por otro usuario → 400
    - PUT /admin/usuarios/{id} con rol inválido → 400
    - forgot-password con email inexistente → 200 (no revela si existe)
    - forgot-password con email existente → token guardado en DB
    - reset-password con token válido → contraseña cambiada, token marcado usado
    - reset-password con token expirado → 400
    - reset-password con token ya usado → 400
    - cambiar-password con password_actual incorrecto → 400
"""

import os
import secrets
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.utils.security import create_access_token, hash_password

# ── Helpers ───────────────────────────────────────────────────────────────────


def _token(rol: str = "admin", user_id: int = 99) -> str:
    return create_access_token({"user_id": user_id, "email": f"{rol}@test.com", "rol": rol})


def _auth(rol: str = "admin") -> dict:
    return {"Authorization": f"Bearer {_token(rol)}"}


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


# ── Fixture de integración ────────────────────────────────────────────────────

def _migraciones_listas() -> bool:
    """True si DB es alcanzable Y las migraciones 007 + 011 están aplicadas."""
    if not os.getenv("DB_HOST"):
        return False
    try:
        from app.database import close_db_connection, get_db_connection
        conn = get_db_connection()
        if not conn:
            return False
        cursor = conn.cursor()
        cursor.execute("SHOW TABLES LIKE 'password_reset_tokens'")
        tabla_ok = bool(cursor.fetchone())
        cursor.execute("SHOW COLUMNS FROM usuarios LIKE 'must_change_password'")
        col_ok = bool(cursor.fetchone())
        cursor.close()
        close_db_connection(conn)
        return tabla_ok and col_ok
    except Exception:
        return False


skip_sin_db = pytest.mark.skipif(
    not _migraciones_listas(),
    reason="Requiere MySQL con migraciones 007 y 011 aplicadas",
)


@pytest.fixture
def db():
    """Conexión MySQL para tests de integración. Hace rollback al terminar."""
    from app.database import close_db_connection, get_db_connection
    conn = get_db_connection()
    if not conn:
        pytest.skip("No se pudo conectar a MySQL")
    yield conn
    conn.rollback()
    close_db_connection(conn)


# ══════════════════════════════════════════════════════════════════════════════
# Permisos — sin MySQL
# ══════════════════════════════════════════════════════════════════════════════


class TestPermisosAdmin:
    def test_listar_usuarios_rechaza_mozo(self, client):
        r = client.get("/admin/usuarios", headers=_auth("mozo"))
        assert r.status_code == 403

    def test_listar_usuarios_rechaza_sin_token(self, client):
        r = client.get("/admin/usuarios")
        # Sin credenciales → 401 (Unauthorized). Se acepta 403 por si el
        # esquema de auth cambia a "Forbidden" para requests anónimos.
        assert r.status_code in (401, 403)

    def test_crear_usuario_rechaza_mozo(self, client):
        r = client.post(
            "/admin/usuarios",
            json={"nombre": "Test", "email": "x@x.com", "rol": "mozo"},
            headers=_auth("mozo"),
        )
        assert r.status_code == 403

    def test_reenviar_bienvenida_rechaza_mozo(self, client):
        r = client.post("/admin/usuarios/1/reenviar-bienvenida", headers=_auth("mozo"))
        assert r.status_code == 403

    def test_editar_usuario_rechaza_mozo(self, client):
        r = client.put(
            "/admin/usuarios/1",
            json={"nombre": "Hackeo"},
            headers=_auth("mozo"),
        )
        assert r.status_code == 403

    def test_cambiar_password_rechaza_sin_token(self, client):
        r = client.post(
            "/auth/cambiar-password",
            json={"password_actual": "vieja", "nueva_password": "nueva1234"},
        )
        # Sin credenciales → 401 (Unauthorized); se tolera 403.
        assert r.status_code in (401, 403)


# ══════════════════════════════════════════════════════════════════════════════
# Rate limit — sin MySQL
# ══════════════════════════════════════════════════════════════════════════════


class TestRateLimitForgotPassword:
    """
    El rate limit es en memoria. Usamos emails únicos por test para evitar
    que el estado de un test afecte a otro.
    """

    def _email(self, suffix: str) -> str:
        return f"ratelimit_{suffix}_{secrets.token_hex(4)}@test.com"

    def test_cuarto_intento_da_429(self, client):
        email = self._email("bloqueo")
        for _ in range(3):
            client.post("/auth/forgot-password", json={"email": email})
        r = client.post("/auth/forgot-password", json={"email": email})
        assert r.status_code == 429

    def test_emails_distintos_no_se_bloquean_entre_si(self, client):
        email_a = self._email("a")
        email_b = self._email("b")
        for _ in range(3):
            client.post("/auth/forgot-password", json={"email": email_a})
        # email_b no debe estar bloqueado por los intentos de email_a
        r = client.post("/auth/forgot-password", json={"email": email_b})
        assert r.status_code != 429

    def test_tres_intentos_permiten_200(self, client):
        email = self._email("ok")
        for _ in range(3):
            r = client.post("/auth/forgot-password", json={"email": email})
            assert r.status_code == 200


# ══════════════════════════════════════════════════════════════════════════════
# Unidad — email_service (SMTP mockeado)
# ══════════════════════════════════════════════════════════════════════════════


class TestEmailService:
    def test_enviar_bienvenida_llama_smtp(self):
        with (
            patch.dict(
                os.environ,
                {
                    "SMTP_HOST": "smtp-relay.brevo.com",
                    "SMTP_PORT": "587",
                    "SMTP_USER": "sender@brevo.com",
                    "SMTP_PASSWORD": "pass123",
                    "EMAIL_FROM": "noreply@scanorder.local",
                },
            ),
            patch("smtplib.SMTP") as mock_smtp,
        ):
            mock_server = MagicMock()
            mock_smtp.return_value.__enter__ = MagicMock(return_value=mock_server)
            mock_smtp.return_value.__exit__ = MagicMock(return_value=False)

            from app.services import email_service
            email_service.enviar_bienvenida("mozo@test.com", "Juan", "TmpPass1!")

            mock_smtp.assert_called_once_with("smtp-relay.brevo.com", 587)
            mock_server.starttls.assert_called_once()
            mock_server.login.assert_called_once_with("sender@brevo.com", "pass123")
            mock_server.sendmail.assert_called_once()
            _, (from_, to_, _), _ = mock_server.sendmail.mock_calls[0]
            assert from_ == "noreply@scanorder.local"
            assert to_ == "mozo@test.com"

    def test_enviar_sin_credenciales_no_lanza_excepcion(self):
        with patch.dict(os.environ, {"SMTP_HOST": "", "SMTP_USER": "", "SMTP_PASSWORD": ""}):
            from app.services import email_service
            # No debe lanzar excepción
            email_service.enviar_bienvenida("x@x.com", "X", "pass")

    def test_enviar_reset_incluye_token_en_url(self):
        import base64
        import email as email_lib

        token = "mi_token_de_prueba"
        with (
            patch.dict(
                os.environ,
                {
                    "SMTP_HOST": "smtp-relay.brevo.com",
                    "SMTP_PORT": "587",
                    "SMTP_USER": "s@brevo.com",
                    "SMTP_PASSWORD": "p",
                    "FRONTEND_URL": "http://localhost:5500",
                },
            ),
            patch("smtplib.SMTP") as mock_smtp,
        ):
            mock_server = MagicMock()
            mock_smtp.return_value.__enter__ = MagicMock(return_value=mock_server)
            mock_smtp.return_value.__exit__ = MagicMock(return_value=False)

            from app.services import email_service
            email_service.enviar_reset_password("u@test.com", "Luli", token)

            _, (_, _, raw_msg), _ = mock_server.sendmail.mock_calls[0]
            # El cuerpo viene en base64; parseamos el mensaje MIME para decodificarlo
            msg = email_lib.message_from_string(raw_msg)
            body = ""
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True)
                    body += payload.decode("utf-8")
            assert token in body
            assert "http://localhost:5500" in body


# ══════════════════════════════════════════════════════════════════════════════
# Integración — requieren MySQL
# ══════════════════════════════════════════════════════════════════════════════


@skip_sin_db
class TestAdminCrearUsuario:
    def test_admin_crea_usuario_debe_cambiar_password(self, client, db):
        email = f"nuevo_{secrets.token_hex(4)}@test.com"
        with patch("app.services.email_service._enviar"):
            r = client.post(
                "/admin/usuarios",
                json={"nombre": "Nuevo Mozo", "email": email, "rol": "mozo"},
                headers=_auth("admin"),
            )
        assert r.status_code == 201
        data = r.json()
        assert data["debe_cambiar_password"] is True
        assert "password_hash" not in data
        assert data["email"] == email

        # Verificar en DB
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT must_change_password FROM usuarios WHERE email = %s", (email,))
        row = cursor.fetchone()
        assert row is not None
        assert bool(row["must_change_password"])  # MySQL devuelve 1/0, no True/False
        cursor.close()

        # Cleanup
        cursor2 = db.cursor()
        cursor2.execute("DELETE FROM usuarios WHERE email = %s", (email,))
        db.commit()
        cursor2.close()

    def test_crear_usuario_email_duplicado_da_400(self, client, db):
        email = f"dup_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Existente", email, hash_password("pass1234"), "mozo"),
        )
        db.commit()
        cursor.close()

        with patch("app.services.email_service._enviar"):
            r = client.post(
                "/admin/usuarios",
                json={"nombre": "Otro", "email": email, "rol": "mozo"},
                headers=_auth("admin"),
            )
        assert r.status_code == 400

        # Cleanup
        cursor2 = db.cursor()
        cursor2.execute("DELETE FROM usuarios WHERE email = %s", (email,))
        db.commit()
        cursor2.close()


@skip_sin_db
class TestListarUsuarios:
    def test_lista_no_incluye_password_hash(self, client):
        r = client.get("/admin/usuarios", headers=_auth("admin"))
        assert r.status_code == 200
        for u in r.json():
            assert "password_hash" not in u


@skip_sin_db
class TestActualizarUsuario:
    def _crear_usuario(self, db, rol="mozo"):
        email = f"edit_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Original", email, hash_password("pass1234"), rol),
        )
        db.commit()
        id_usuario = cursor.lastrowid
        cursor.close()
        return id_usuario, email

    def _cleanup(self, db, id_usuario):
        cursor = db.cursor()
        cursor.execute("DELETE FROM usuarios WHERE id_usuario = %s", (id_usuario,))
        db.commit()
        cursor.close()

    def test_editar_usuario_persiste_cambios(self, client, db):
        id_usuario, _ = self._crear_usuario(db)
        try:
            nuevo_email = f"editado_{secrets.token_hex(4)}@test.com"
            r = client.put(
                f"/admin/usuarios/{id_usuario}",
                json={"nombre": "Editado", "email": nuevo_email, "rol": "admin"},
                headers=_auth("admin"),
            )
            assert r.status_code == 200
            data = r.json()
            assert data["nombre"] == "Editado"
            assert data["email"] == nuevo_email
            assert data["rol"] == "admin"
            assert "password_hash" not in data

            cursor = db.cursor(dictionary=True)
            cursor.execute(
                "SELECT nombre, email, rol FROM usuarios WHERE id_usuario = %s", (id_usuario,)
            )
            row = cursor.fetchone()
            assert row["nombre"] == "Editado"
            assert row["email"] == nuevo_email
            assert row["rol"] == "admin"
            cursor.close()
        finally:
            self._cleanup(db, id_usuario)

    def test_editar_email_duplicado_da_400(self, client, db):
        id_a, email_a = self._crear_usuario(db)
        id_b, _ = self._crear_usuario(db)
        try:
            r = client.put(
                f"/admin/usuarios/{id_b}",
                json={"email": email_a},
                headers=_auth("admin"),
            )
            assert r.status_code == 400
        finally:
            self._cleanup(db, id_a)
            self._cleanup(db, id_b)

    def test_editar_rol_invalido_da_400(self, client, db):
        id_usuario, _ = self._crear_usuario(db)
        try:
            r = client.put(
                f"/admin/usuarios/{id_usuario}",
                json={"rol": "super-admin"},
                headers=_auth("admin"),
            )
            assert r.status_code == 400
        finally:
            self._cleanup(db, id_usuario)


@skip_sin_db
class TestForgotPassword:
    def test_email_inexistente_devuelve_200(self, client):
        email = f"noexiste_{secrets.token_hex(6)}@nowhere.com"
        r = client.post("/auth/forgot-password", json={"email": email})
        assert r.status_code == 200

    def test_email_existente_crea_token(self, client, db):
        email = f"reset_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Reset User", email, hash_password("pass1234"), "mozo"),
        )
        db.commit()
        id_usuario = cursor.lastrowid
        cursor.close()

        with patch("app.services.email_service._enviar"):
            r = client.post("/auth/forgot-password", json={"email": email})
        assert r.status_code == 200

        cursor2 = db.cursor(dictionary=True)
        cursor2.execute(
            "SELECT token, usado FROM password_reset_tokens WHERE id_usuario = %s",
            (id_usuario,),
        )
        rows = cursor2.fetchall()
        assert len(rows) == 1
        assert rows[0]["usado"] == 0
        cursor2.close()

        # Cleanup
        cursor3 = db.cursor()
        cursor3.execute("DELETE FROM password_reset_tokens WHERE id_usuario = %s", (id_usuario,))
        cursor3.execute("DELETE FROM usuarios WHERE id_usuario = %s", (id_usuario,))
        db.commit()
        cursor3.close()


@skip_sin_db
class TestResetPassword:
    def _setup_user_and_token(self, db, expira_en, usado=False):
        email = f"rst_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Rst User", email, hash_password("vieja1234"), "mozo"),
        )
        db.commit()
        id_usuario = cursor.lastrowid
        token = secrets.token_urlsafe(32)
        cursor.execute(
            "INSERT INTO password_reset_tokens (id_usuario, token, expira_en, usado) VALUES (%s,%s,%s,%s)",
            (id_usuario, token, expira_en, usado),
        )
        db.commit()
        cursor.close()
        return id_usuario, email, token

    def _cleanup(self, db, id_usuario):
        cursor = db.cursor()
        cursor.execute("DELETE FROM password_reset_tokens WHERE id_usuario = %s", (id_usuario,))
        cursor.execute("DELETE FROM usuarios WHERE id_usuario = %s", (id_usuario,))
        db.commit()
        cursor.close()

    def test_token_valido_cambia_password(self, client, db):
        expira = datetime.utcnow() + timedelta(minutes=30)
        id_usuario, email, token = self._setup_user_and_token(db, expira)
        try:
            r = client.post(
                "/auth/reset-password",
                json={"token": token, "nueva_password": "NuevaClave9!"},
            )
            assert r.status_code == 200

            cursor = db.cursor(dictionary=True)
            cursor.execute(
                "SELECT usado FROM password_reset_tokens WHERE token = %s", (token,)
            )
            row = cursor.fetchone()
            assert row["usado"] == 1
            cursor.execute(
                "SELECT must_change_password FROM usuarios WHERE id_usuario = %s", (id_usuario,)
            )
            user_row = cursor.fetchone()
            assert user_row["must_change_password"] == 0
            cursor.close()
        finally:
            self._cleanup(db, id_usuario)

    def test_token_expirado_da_400(self, client, db):
        expira = datetime.utcnow() - timedelta(minutes=1)
        id_usuario, _, token = self._setup_user_and_token(db, expira)
        try:
            r = client.post(
                "/auth/reset-password",
                json={"token": token, "nueva_password": "NuevaClave9!"},
            )
            assert r.status_code == 400
            assert "expir" in r.json()["detail"].lower()
        finally:
            self._cleanup(db, id_usuario)

    def test_token_ya_usado_da_400(self, client, db):
        expira = datetime.utcnow() + timedelta(minutes=30)
        id_usuario, _, token = self._setup_user_and_token(db, expira, usado=True)
        try:
            r = client.post(
                "/auth/reset-password",
                json={"token": token, "nueva_password": "NuevaClave9!"},
            )
            assert r.status_code == 400
            assert "utilizado" in r.json()["detail"].lower()
        finally:
            self._cleanup(db, id_usuario)

    def test_token_invalido_da_400(self, client):
        r = client.post(
            "/auth/reset-password",
            json={"token": "token_que_no_existe", "nueva_password": "NuevaClave9!"},
        )
        assert r.status_code == 400


@skip_sin_db
class TestCambiarPassword:
    def test_password_actual_incorrecto_da_400(self, client, db):
        email = f"cambio_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Cambio User", email, hash_password("correcta1234"), "mozo"),
        )
        db.commit()
        id_usuario = cursor.lastrowid
        cursor.close()

        try:
            tok = create_access_token({"user_id": id_usuario, "email": email, "rol": "mozo"})
            r = client.post(
                "/auth/cambiar-password",
                json={"password_actual": "INCORRECTA", "nueva_password": "nueva1234"},
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 400
            assert "incorrecta" in r.json()["detail"].lower()
        finally:
            cursor2 = db.cursor()
            cursor2.execute("DELETE FROM usuarios WHERE id_usuario = %s", (id_usuario,))
            db.commit()
            cursor2.close()

    def test_password_correcto_actualiza(self, client, db):
        email = f"cambio_ok_{secrets.token_hex(4)}@test.com"
        cursor = db.cursor()
        cursor.execute(
            "INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (%s,%s,%s,%s)",
            ("Cambio OK", email, hash_password("correcta1234"), "mozo"),
        )
        db.commit()
        id_usuario = cursor.lastrowid
        cursor.close()

        try:
            tok = create_access_token({"user_id": id_usuario, "email": email, "rol": "mozo"})
            r = client.post(
                "/auth/cambiar-password",
                json={"password_actual": "correcta1234", "nueva_password": "nuevaClave9!"},
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200

            cursor2 = db.cursor(dictionary=True)
            cursor2.execute(
                "SELECT must_change_password FROM usuarios WHERE id_usuario = %s", (id_usuario,)
            )
            assert cursor2.fetchone()["must_change_password"] == 0
            cursor2.close()
        finally:
            cursor3 = db.cursor()
            cursor3.execute("DELETE FROM usuarios WHERE id_usuario = %s", (id_usuario,))
            db.commit()
            cursor3.close()


# ══════════════════════════════════════════════════════════════════════════════
# Graceful degradation — columna must_change_password ausente (sin MySQL real)
# ══════════════════════════════════════════════════════════════════════════════
#
# Simula una instalación limpia sin la migración 007 aplicada, mockeando el
# cursor para que "SHOW COLUMNS ... LIKE 'must_change_password'" no encuentre
# nada — mismo patrón que ya usa test_inventory.py para tabla_tiene_columna.
# Antes de este fix, estos endpoints tiraban 500 crudo en ese escenario.


class TestMustChangePasswordColumnaAusente:
    def test_auth_me_sin_columna_no_rompe(self, client):
        with patch.dict("app.routes.auth._col_cache", {}, clear=True):
            with patch("app.routes.auth.get_db_connection") as mock_conn:
                conn = MagicMock()
                mock_conn.return_value = conn
                cursor = MagicMock()
                conn.cursor.return_value = cursor

                cursor.fetchone.side_effect = [
                    None,  # usuarios_tiene_columna("must_change_password") → no existe
                    {  # SELECT ... FALSE AS debe_cambiar_password ...
                        "id_usuario": 99,
                        "nombre": "Admin Test",
                        "email": "admin@test.com",
                        "rol": "admin",
                        "debe_cambiar_password": 0,
                        "activo": 1,
                    },
                ]

                r = client.get("/auth/me", headers=_auth("admin"))

        assert r.status_code == 200
        assert r.json()["user"]["debe_cambiar_password"] is False

    def test_listar_usuarios_sin_columna_no_rompe(self, client):
        with patch.dict("app.routes.admin._col_cache", {}, clear=True):
            with patch("app.routes.admin.get_db_connection") as mock_conn:
                conn = MagicMock()
                mock_conn.return_value = conn
                cursor = MagicMock()
                conn.cursor.return_value = cursor

                cursor.fetchone.return_value = None  # usuarios_tiene_columna → no existe
                cursor.fetchall.return_value = [
                    {
                        "id_usuario": 1,
                        "nombre": "Mozo Test",
                        "email": "mozo@test.com",
                        "rol": "mozo",
                        "debe_cambiar_password": 0,
                        "activo": 1,
                        "created_at": "2026-01-01",
                    }
                ]

                r = client.get("/admin/usuarios", headers=_auth("admin"))

        assert r.status_code == 200
        assert r.json()[0]["debe_cambiar_password"] is False
