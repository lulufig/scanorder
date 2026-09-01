"""
Tests de integración para GET /reportes/mozos (rendimiento por mozo).

Contra una base MySQL real y descartable. Si no hay MySQL accesible con las
credenciales de backend/.env, el módulo se saltea entero.

El endpoint agrega tres fuentes que ya se guardan: cierres_mesa.id_usuario_cierre,
movimientos_stock (salida).created_by y mozo_llamados.atendido_por.
"""
import os

import mysql.connector
import pytest
from fastapi.testclient import TestClient

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", 3306))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
TEST_DB_NAME = "scanorder_test_repmozos"

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATABASE_SQL_PATH = os.path.join(BACKEND_DIR, "..", "docs", "database.sql")
MIG_010 = os.path.join(BACKEND_DIR, "migrations", "010_inventory.sql")
MIG_014 = os.path.join(BACKEND_DIR, "migrations", "014_mozo_llamados.sql")
MIG_015 = os.path.join(BACKEND_DIR, "migrations", "015_propina.sql")
MIG_017 = os.path.join(BACKEND_DIR, "migrations", "017_cierre_rendido.sql")


def _mysql_disponible() -> bool:
    try:
        conn = mysql.connector.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD)
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
    text = "\n".join(ln for ln in lines if not ln.strip().startswith("--"))
    out = []
    for chunk in text.split(";"):
        stmt = chunk.strip()
        if not stmt:
            continue
        if stmt.upper().startswith(("USE ", "CREATE DATABASE")):
            continue
        out.append(stmt)
    return out


@pytest.fixture(scope="module")
def module_env():
    keys = ("DB_NAME", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD")
    previous = {k: os.environ.get(k) for k in keys}
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
    admin = mysql.connector.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD)
    ac = admin.cursor()
    ac.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
    ac.execute(f"CREATE DATABASE {TEST_DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    admin.commit()

    conn = mysql.connector.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=TEST_DB_NAME
    )
    cur = conn.cursor()
    for path in (DATABASE_SQL_PATH, MIG_010, MIG_014, MIG_015, MIG_017):
        for stmt in _parse_statements(path):
            cur.execute(stmt)
    conn.commit()

    # ── Semilla ────────────────────────────────────────────────────────────
    # Usuarios: mozo con actividad, mozo activo sin actividad, mozo inactivo sin
    # actividad (no debe aparecer), admin con un cierre.
    cur.execute(
        "INSERT INTO usuarios (id_usuario, nombre, email, password_hash, rol, activo) VALUES "
        "(10, 'Lucia Mozo', 'lucia@t.com', 'x', 'mozo', 1),"
        "(11, 'Sin Actividad', 'sa@t.com', 'x', 'mozo', 1),"
        "(12, 'Baja Logica', 'bl@t.com', 'x', 'mozo', 0),"
        "(13, 'Admin Test', 'adm@t.com', 'x', 'admin', 1)"
    )
    cur.execute("INSERT INTO categorias (nombre) VALUES ('cat')")
    cur.execute("INSERT INTO productos (id_categoria, nombre, precio, stock_actual) VALUES (1, 'Burger', 1000, 50)")
    cur.execute("INSERT INTO mesas (numero) VALUES (1), (2)")

    # 3 pedidos en mesa 1, entregados por Lucia (movimientos_stock.created_by=10)
    for _ in range(3):
        cur.execute("INSERT INTO pedidos (id_mesa, estado, total) VALUES (1, 'entregado', 1000)")
        pid = cur.lastrowid
        cur.execute(
            "INSERT INTO detalle_pedidos (id_pedido, id_producto, cantidad, precio_unitario, subtotal) "
            "VALUES (%s, 1, 1, 1000, 1000)", (pid,)
        )
        cur.execute(
            "INSERT INTO movimientos_stock (id_producto, cantidad, tipo, id_pedido, created_by) "
            "VALUES (1, 1, 'salida', %s, 10)", (pid,)
        )

    # 2 cierres por Lucia (total 3000, propina 200+100=300) + 1 del admin (total 5000, sin propina)
    cur.execute("INSERT INTO cierres_mesa (id_mesa, numero_mesa, metodo_pago, total_consumido, monto_cobrado, vuelto, propina, id_usuario_cierre) VALUES (1, 1, 'efectivo', 2000, 2200, 0, 200, 10)")
    cur.execute("INSERT INTO cierres_mesa (id_mesa, numero_mesa, metodo_pago, total_consumido, monto_cobrado, vuelto, propina, id_usuario_cierre) VALUES (1, 1, 'efectivo', 1000, 1100, 0, 100, 10)")
    cur.execute("INSERT INTO cierres_mesa (id_mesa, numero_mesa, metodo_pago, total_consumido, monto_cobrado, vuelto, propina, id_usuario_cierre) VALUES (2, 2, 'tarjeta', 5000, 5000, 0, 0, 13)")

    # 2 llamados atendidos por Lucia: 60s y 180s → promedio 120s = 2.0 min
    cur.execute("INSERT INTO mozo_llamados (id_mesa, tipo, solicitado_at, atendido_at, atendido_por) VALUES (1, 'mozo', NOW() - INTERVAL 60 SECOND, NOW(), 10)")
    cur.execute("INSERT INTO mozo_llamados (id_mesa, tipo, solicitado_at, atendido_at, atendido_por) VALUES (1, 'cuenta', NOW() - INTERVAL 180 SECOND, NOW(), 10)")
    conn.commit()
    conn.close()

    yield

    ac.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
    admin.commit()
    admin.close()


@pytest.fixture(autouse=True)
def reset_col_cache():
    """_col_cache es global en reportes.py; lo limpiamos para no arrastrar
    resultados de SHOW TABLES de otros módulos de test."""
    from app.routes.reportes import _col_cache
    _col_cache.clear()
    yield
    _col_cache.clear()


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
def admin_token():
    from app.utils.security import create_access_token
    return create_access_token({"user_id": 13, "email": "adm@t.com", "rol": "admin"})


@pytest.fixture
def lucia_token():
    from app.utils.security import create_access_token
    return create_access_token({"user_id": 10, "email": "lucia@t.com", "rol": "mozo"})


def _get(client, token, extra=""):
    return client.get(
        f"/reportes/mozos?fecha_inicio=2000-01-01&fecha_fin=2999-12-31{extra}",
        headers={"Authorization": f"Bearer {token}"},
    )


class TestReportePorMozo:
    def test_agrega_las_tres_fuentes_para_el_mozo(self, client, admin_token):
        resp = _get(client, admin_token)
        assert resp.status_code == 200
        mozos = {m["nombre"]: m for m in resp.json()["mozos"]}

        lucia = mozos["Lucia Mozo"]
        assert lucia["mesas_cerradas"] == 2
        assert lucia["ventas_cobradas"] == 3000.0
        assert lucia["ticket_promedio"] == 1500.0
        assert lucia["propinas"] == 300.0
        assert lucia["pedidos_entregados"] == 3
        assert lucia["llamados_atendidos"] == 2
        assert lucia["respuesta_promedio_min"] == 2.0

    def test_el_admin_no_aparece_en_el_reporte(self, client, admin_token):
        # El roster de /reportes/mozos es solo rol='mozo' (ver "Control de mozos").
        mozos = {m["nombre"] for m in _get(client, admin_token).json()["mozos"]}
        assert "Admin Test" not in mozos

    def test_mozo_activo_sin_actividad_aparece_en_cero(self, client, admin_token):
        mozos = {m["nombre"]: m for m in _get(client, admin_token).json()["mozos"]}
        assert "Sin Actividad" in mozos
        assert mozos["Sin Actividad"]["ventas_cobradas"] == 0.0
        assert mozos["Sin Actividad"]["respuesta_promedio_min"] is None

    def test_usuario_inactivo_sin_actividad_se_excluye(self, client, admin_token):
        mozos = {m["nombre"] for m in _get(client, admin_token).json()["mozos"]}
        assert "Baja Logica" not in mozos

    def test_totales(self, client, admin_token):
        totales = _get(client, admin_token).json()["totales"]
        # Solo mozos: 2 cierres de Lucia (el del admin no entra).
        assert totales["mesas_cerradas"] == 2
        assert totales["ventas_cobradas"] == 3000.0
        assert totales["propinas"] == 300.0
        assert totales["pedidos_entregados"] == 3

    def test_rango_invertido_da_400(self, client, admin_token):
        resp = client.get(
            "/reportes/mozos?fecha_inicio=2026-12-31&fecha_fin=2026-01-01",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 400

    def test_excel_devuelve_archivo(self, client, admin_token):
        resp = _get(client, admin_token, "&formato=excel")
        assert resp.status_code == 200
        assert "spreadsheetml" in resp.headers["content-type"]

    def test_mozo_no_puede_ver_el_reporte(self, client):
        from app.utils.security import create_access_token
        tok = create_access_token({"user_id": 10, "email": "lucia@t.com", "rol": "mozo"})
        resp = _get(client, tok)
        assert resp.status_code == 403


class TestCajaMia:
    """GET /caja/mia: los cobros del usuario actual en un día."""

    def test_mozo_ve_sus_cobros_de_hoy(self, client, lucia_token):
        resp = client.get("/caja/mia", headers={"Authorization": f"Bearer {lucia_token}"})
        assert resp.status_code == 200
        d = resp.json()
        r = d["resumen"]
        assert r["mesas_cobradas"] == 2
        assert r["total_cobrado"] == 3000.0
        assert r["propinas"] == 300.0
        assert r["efectivo_a_rendir"] == 3000.0
        assert r["efectivo_rendido"] == 0.0
        assert r["efectivo_pendiente"] == 3000.0
        assert r["por_metodo"] == {"efectivo": 3000.0}
        assert len(d["cobros"]) == 2
        assert d["cobros"][0]["numero_mesa"] == 1  # JOIN a mesas, no el numero_mesa muerto
        assert d["cobros"][0]["rendido"] is False  # efectivo, sin rendir

    def test_admin_ve_su_propia_caja(self, client, admin_token):
        r = client.get("/caja/mia", headers={"Authorization": f"Bearer {admin_token}"}).json()["resumen"]
        assert r["mesas_cobradas"] == 1
        assert r["total_cobrado"] == 5000.0
        assert r["efectivo_a_rendir"] == 0.0        # cobró con tarjeta
        assert r["por_metodo"] == {"tarjeta": 5000.0}

    def test_dia_sin_cobros_devuelve_vacio(self, client, lucia_token):
        r = client.get(
            "/caja/mia?fecha=2020-01-01",
            headers={"Authorization": f"Bearer {lucia_token}"},
        ).json()
        assert r["resumen"]["mesas_cobradas"] == 0
        assert r["cobros"] == []

    def test_sin_auth_401(self, client):
        assert client.get("/caja/mia").status_code in {401, 403}


class TestCajaResumen:
    """GET /caja/resumen: consolidado del día (solo admin)."""

    def test_totales_y_por_mozo(self, client, admin_token):
        d = client.get("/caja/resumen", headers={"Authorization": f"Bearer {admin_token}"}).json()
        t = d["totales"]
        assert t["efectivo"] == 3000.0   # 2 cierres de Lucia
        assert t["tarjeta"] == 5000.0    # 1 del admin
        assert t["total"] == 8000.0
        assert t["propinas"] == 300.0

        por_mozo = {m["nombre"]: m for m in d["por_mozo"]}
        assert por_mozo["Lucia Mozo"]["efectivo_cobrado"] == 3000.0
        assert por_mozo["Lucia Mozo"]["efectivo_rendido"] == 0.0
        assert por_mozo["Lucia Mozo"]["efectivo_pendiente"] == 3000.0
        assert por_mozo["Admin Test"]["otros_metodos"] == 5000.0

    def test_mozo_no_puede_ver_el_resumen(self, client, lucia_token):
        resp = client.get("/caja/resumen", headers={"Authorization": f"Bearer {lucia_token}"})
        assert resp.status_code == 403


class TestRendirCobro:
    """POST /caja/cobros/{id}/rendir."""

    def _cierre(self, db_conn, id_usuario, metodo):
        cur = db_conn.cursor(dictionary=True)
        cur.execute(
            "SELECT id_cierre FROM cierres_mesa WHERE id_usuario_cierre = %s "
            "AND metodo_pago = %s LIMIT 1",
            (id_usuario, metodo),
        )
        return cur.fetchone()["id_cierre"]

    def test_mozo_marca_y_desmarca_su_cobro(self, db_conn, client, lucia_token):
        idc = self._cierre(db_conn, 10, "efectivo")  # Lucia
        r = client.post(f"/caja/cobros/{idc}/rendir", json={"rendido": True},
                        headers={"Authorization": f"Bearer {lucia_token}"})
        assert r.status_code == 200 and r.json()["rendido"] is True
        db_conn.commit()
        mia = client.get("/caja/mia", headers={"Authorization": f"Bearer {lucia_token}"}).json()
        assert mia["resumen"]["efectivo_rendido"] > 0

        client.post(f"/caja/cobros/{idc}/rendir", json={"rendido": False},
                    headers={"Authorization": f"Bearer {lucia_token}"})
        db_conn.commit()
        cur = db_conn.cursor()
        cur.execute("SELECT rendido_at FROM cierres_mesa WHERE id_cierre = %s", (idc,))
        assert cur.fetchone()[0] is None

    def test_mozo_no_puede_rendir_cobro_ajeno(self, db_conn, client, lucia_token):
        cur = db_conn.cursor()
        cur.execute(
            "INSERT INTO cierres_mesa (id_mesa, numero_mesa, metodo_pago, total_consumido, "
            "monto_cobrado, vuelto, id_usuario_cierre) VALUES (1, 0, 'efectivo', 100, 100, 0, 11)"
        )
        ajeno = cur.lastrowid
        db_conn.commit()
        r = client.post(f"/caja/cobros/{ajeno}/rendir", json={"rendido": True},
                        headers={"Authorization": f"Bearer {lucia_token}"})
        assert r.status_code == 403

    def test_admin_puede_rendir_cualquiera(self, db_conn, client, admin_token):
        idc = self._cierre(db_conn, 10, "efectivo")
        r = client.post(f"/caja/cobros/{idc}/rendir", json={"rendido": True},
                        headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        db_conn.commit()
        client.post(f"/caja/cobros/{idc}/rendir", json={"rendido": False},
                    headers={"Authorization": f"Bearer {admin_token}"})
        db_conn.commit()

    def test_no_se_puede_rendir_un_cobro_no_efectivo(self, db_conn, client, admin_token):
        idc = self._cierre(db_conn, 13, "tarjeta")  # el cierre del admin es tarjeta
        r = client.post(f"/caja/cobros/{idc}/rendir", json={"rendido": True},
                        headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 400
