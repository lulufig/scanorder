"""
Tests de integración para la trazabilidad de llamados de mozo (migración 014).

Contra una base MySQL real y descartable (scanorder_test_llamados). Si no hay
MySQL accesible con las credenciales de backend/.env, el módulo se saltea entero.

Cubre el repositorio app/repositories/mozo_llamados_repo.py y su integración con
GET /mesas/mapa (el campo minutos_llamado / llamado_tomado_por) y el endpoint
POST /mesas/{id}/tomar-llamado.
"""
import os
import uuid

import mysql.connector
import pytest
from fastapi.testclient import TestClient

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", 3306))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
TEST_DB_NAME = "scanorder_test_llamados"

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATABASE_SQL_PATH = os.path.join(BACKEND_DIR, "..", "docs", "database.sql")
MIGRATION_014_PATH = os.path.join(BACKEND_DIR, "migrations", "014_mozo_llamados.sql")


def _mysql_disponible() -> bool:
    try:
        conn = mysql.connector.connect(
            host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD
        )
        conn.close()
        return True
    except mysql.connector.Error:
        return False


pytestmark = pytest.mark.skipif(
    not _mysql_disponible(),
    reason="Requiere un MySQL accesible en DB_HOST/DB_PORT (backend/.env)",
)


def _parse_statements(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    kept = [ln for ln in lines if not ln.strip().startswith("--")]
    text = "\n".join(kept)
    statements = []
    for chunk in text.split(";"):
        stmt = chunk.strip()
        if not stmt:
            continue
        upper = stmt.upper()
        if upper.startswith("USE ") or upper.startswith("CREATE DATABASE"):
            continue
        statements.append(stmt)
    return statements


@pytest.fixture(scope="module")
def module_env():
    previous = {k: os.environ.get(k) for k in ("DB_NAME", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD")}
    os.environ["DB_NAME"] = TEST_DB_NAME
    os.environ["DB_HOST"] = DB_HOST
    os.environ["DB_PORT"] = str(DB_PORT)
    os.environ["DB_USER"] = DB_USER
    os.environ["DB_PASSWORD"] = DB_PASSWORD
    yield
    for k, v in previous.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@pytest.fixture(scope="module", autouse=True)
def schema(module_env):
    admin_conn = mysql.connector.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD
    )
    admin_cur = admin_conn.cursor()
    admin_cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
    admin_cur.execute(
        f"CREATE DATABASE {TEST_DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    admin_conn.commit()

    conn = mysql.connector.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=TEST_DB_NAME
    )
    cur = conn.cursor()
    for stmt in _parse_statements(DATABASE_SQL_PATH):
        cur.execute(stmt)
    for stmt in _parse_statements(MIGRATION_014_PATH):
        cur.execute(stmt)
    conn.commit()
    conn.close()

    yield

    admin_cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
    admin_conn.commit()
    admin_conn.close()


@pytest.fixture
def db_conn(schema):
    conn = mysql.connector.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=TEST_DB_NAME
    )
    yield conn
    conn.close()


@pytest.fixture
def client(schema):
    from app.main import app

    return TestClient(app)


@pytest.fixture
def mozo_token():
    from app.utils.security import create_access_token

    return create_access_token({"user_id": 7, "email": "mozo@test.com", "rol": "mozo"})


def _seed_mesa(db_conn) -> int:
    numero = int(uuid.uuid4().int % 1_000_000) + 1
    cur = db_conn.cursor()
    cur.execute("INSERT INTO mesas (numero) VALUES (%s)", (numero,))
    id_mesa = cur.lastrowid
    db_conn.commit()
    return id_mesa


def _seed_usuario(db_conn, id_usuario=7, nombre="Lucía Mozo") -> int:
    cur = db_conn.cursor()
    cur.execute(
        "INSERT IGNORE INTO usuarios (id_usuario, nombre, email, password_hash, rol) "
        "VALUES (%s, %s, %s, 'x', 'mozo')",
        (id_usuario, nombre, f"u{id_usuario}@test.com"),
    )
    db_conn.commit()
    return id_usuario


# ── Repositorio ──────────────────────────────────────────────────────────────

class TestRepoLlamados:
    def test_registrar_y_snapshot(self, db_conn):
        from app.repositories.mozo_llamados_repo import (
            registrar_llamado, snapshot_llamados_abiertos,
        )
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")

        snap = snapshot_llamados_abiertos()
        assert id_mesa in snap
        assert snap[id_mesa]["tipo"] == "mozo"
        assert snap[id_mesa]["tomado_por"] is None
        assert snap[id_mesa]["minutos"] >= 0

    def test_registrar_cierra_el_llamado_previo(self, db_conn):
        from app.repositories.mozo_llamados_repo import (
            registrar_llamado, snapshot_llamados_abiertos,
        )
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")
        registrar_llamado(id_mesa, "cuenta")

        snap = snapshot_llamados_abiertos()
        assert snap[id_mesa]["tipo"] == "cuenta"

        cur = db_conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM mozo_llamados WHERE id_mesa = %s AND atendido_at IS NULL",
            (id_mesa,),
        )
        assert cur.fetchone()[0] == 1

    def test_tomar_llamado_registra_el_mozo(self, db_conn):
        from app.repositories.mozo_llamados_repo import (
            registrar_llamado, tomar_llamado, snapshot_llamados_abiertos,
        )
        _seed_usuario(db_conn, 7, "Lucía Mozo")
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")

        assert tomar_llamado(id_mesa, 7) is True

        snap = snapshot_llamados_abiertos()
        assert snap[id_mesa]["tomado_por"] == 7
        assert snap[id_mesa]["tomado_por_nombre"] == "Lucía Mozo"

    def test_tomar_llamado_sin_llamado_abierto_devuelve_false(self, db_conn):
        from app.repositories.mozo_llamados_repo import tomar_llamado
        id_mesa = _seed_mesa(db_conn)
        assert tomar_llamado(id_mesa, 7) is False

    def test_cerrar_llamado_lo_saca_del_snapshot(self, db_conn):
        from app.repositories.mozo_llamados_repo import (
            registrar_llamado, cerrar_llamado, snapshot_llamados_abiertos,
        )
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")
        cerrar_llamado(id_mesa, "mozo", 7)

        assert id_mesa not in snapshot_llamados_abiertos()

    def test_cerrar_llamado_filtra_por_tipo(self, db_conn):
        from app.repositories.mozo_llamados_repo import (
            registrar_llamado, cerrar_llamado, snapshot_llamados_abiertos,
        )
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "cuenta")
        cerrar_llamado(id_mesa, "mozo")  # tipo distinto: no debe cerrar nada

        assert id_mesa in snapshot_llamados_abiertos()


# ── Endpoint POST /mesas/{id}/tomar-llamado ──────────────────────────────────

class TestEndpointTomarLlamado:
    def test_sin_llamado_abierto_devuelve_409(self, db_conn, client, mozo_token):
        id_mesa = _seed_mesa(db_conn)
        resp = client.post(
            f"/mesas/{id_mesa}/tomar-llamado",
            headers={"Authorization": f"Bearer {mozo_token}"},
        )
        assert resp.status_code == 409

    def test_mesa_inexistente_devuelve_404(self, client, mozo_token):
        resp = client.post(
            "/mesas/999999/tomar-llamado",
            headers={"Authorization": f"Bearer {mozo_token}"},
        )
        assert resp.status_code == 404

    def test_toma_un_llamado_abierto(self, db_conn, client, mozo_token):
        from app.repositories.mozo_llamados_repo import registrar_llamado
        _seed_usuario(db_conn, 7, "Lucía Mozo")
        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")

        resp = client.post(
            f"/mesas/{id_mesa}/tomar-llamado",
            headers={"Authorization": f"Bearer {mozo_token}"},
        )
        assert resp.status_code == 200

        cur = db_conn.cursor(dictionary=True)
        cur.execute(
            "SELECT tomado_por FROM mozo_llamados WHERE id_mesa = %s AND atendido_at IS NULL",
            (id_mesa,),
        )
        assert cur.fetchone()["tomado_por"] == 7


# ── Integración con GET /mesas/mapa ──────────────────────────────────────────

class TestMapaExponeLlamado:
    def test_mapa_incluye_minutos_llamado_cuando_hay_flag_operativo(
        self, db_conn, client, mozo_token
    ):
        """El cronómetro se muestra solo si el flag operativo sigue activo.
        Simulamos el flujo real: registrar el llamado + prender el flag."""
        from app.repositories.mozo_llamados_repo import registrar_llamado
        from app.services.mesa_state import mesa_operational_state

        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")
        mesa_operational_state.touch(id_mesa, ocupada=True, mozo_solicitado=True)

        resp = client.get(
            "/mesas/mapa", headers={"Authorization": f"Bearer {mozo_token}"}
        )
        assert resp.status_code == 200
        fila = next(m for m in resp.json() if m["id_mesa"] == id_mesa)
        assert fila["mozo_solicitado"] is True
        assert fila["minutos_llamado"] is not None
        assert fila["llamado_tomado_por"] is None

        mesa_operational_state.release(id_mesa)

    def test_mapa_no_muestra_cronometro_sin_flag_operativo(
        self, db_conn, client, mozo_token
    ):
        """Fila de trazabilidad colgada (sin flag): no debe pintar cronómetro."""
        from app.repositories.mozo_llamados_repo import registrar_llamado

        id_mesa = _seed_mesa(db_conn)
        registrar_llamado(id_mesa, "mozo")  # flag operativo nunca se prendió

        resp = client.get(
            "/mesas/mapa", headers={"Authorization": f"Bearer {mozo_token}"}
        )
        fila = next(m for m in resp.json() if m["id_mesa"] == id_mesa)
        assert fila["minutos_llamado"] is None
