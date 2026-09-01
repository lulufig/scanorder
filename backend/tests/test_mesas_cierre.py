"""
Tests de integración para POST /mesas/{id_mesa}/cerrar contra una base MySQL real
y descartable (no contra scanorder_db). Se necesita un servidor MySQL accesible con
las credenciales de backend/.env (host/puerto/user/password); si no hay uno disponible,
estos tests se saltan automáticamente (no rompen el resto de la suite).

Por qué con DB real y no con un cursor mockeado: lo que se quiere probar es el
comportamiento de COMMIT/ROLLBACK de InnoDB ante un fallo a mitad de transacción.
Un mock solo demuestra que el código Python invoca rollback(), no que la base
efectivamente descarta los INSERTs ya emitidos.
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
TEST_DB_NAME = "scanorder_test_cierre"

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATABASE_SQL_PATH = os.path.join(BACKEND_DIR, "..", "docs", "database.sql")
INVENTORY_MIGRATION_PATH = os.path.join(BACKEND_DIR, "migrations", "010_inventory.sql")
PROPINA_MIGRATION_PATH = os.path.join(BACKEND_DIR, "migrations", "015_propina.sql")
ASIGNADO_MIGRATION_PATH = os.path.join(BACKEND_DIR, "migrations", "016_mesa_mozo_asignado.sql")


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
    reason="Requiere un MySQL accesible en DB_HOST/DB_PORT (backend/.env) para probar atomicidad real",
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


@pytest.fixture(scope="module", autouse=True)
def schema(monkeypatch_module_env):
    """Crea scanorder_test_cierre, carga docs/database.sql, la dropea al final."""
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
    # docs/database.sql es el snapshot consolidado hasta la migración 006; el
    # control de inventario (stock_actual, movimientos_stock) es posterior
    # (migración 010) y no está incluido ahí. Se aplica acá para poder probar
    # que cobrar una mesa no descuenta stock (eso solo pasa al entregar).
    for stmt in _parse_statements(INVENTORY_MIGRATION_PATH):
        cur.execute(stmt)
    # migración 015: columna propina en cierres_mesa (posterior a database.sql).
    for stmt in _parse_statements(PROPINA_MIGRATION_PATH):
        cur.execute(stmt)
    # migración 016: columna mesas.id_mozo_asignado.
    for stmt in _parse_statements(ASIGNADO_MIGRATION_PATH):
        cur.execute(stmt)
    conn.commit()
    conn.close()

    yield

    admin_cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB_NAME}")
    admin_conn.commit()
    admin_conn.close()


@pytest.fixture(scope="module")
def monkeypatch_module_env():
    """Apunta DB_NAME a la base descartable para todo el módulo (get_db_connection
    lee os.getenv en cada llamada, no al importar, así que esto alcanza)."""
    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = TEST_DB_NAME
    os.environ["DB_HOST"] = DB_HOST
    os.environ["DB_PORT"] = str(DB_PORT)
    os.environ["DB_USER"] = DB_USER
    os.environ["DB_PASSWORD"] = DB_PASSWORD
    yield
    if previous is None:
        os.environ.pop("DB_NAME", None)
    else:
        os.environ["DB_NAME"] = previous


@pytest.fixture
def db_conn(schema):
    conn = mysql.connector.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=TEST_DB_NAME
    )
    yield conn
    conn.close()


@pytest.fixture
def admin_token():
    from app.utils.security import create_access_token

    return create_access_token({"user_id": 1, "email": "admin@test.com", "rol": "admin"})


@pytest.fixture
def mozo_token():
    from app.utils.security import create_access_token

    return create_access_token({"user_id": 2, "email": "mozo@test.com", "rol": "mozo"})


@pytest.fixture
def client(schema):
    from app.main import app

    return TestClient(app)


def _seed_admin_usuario(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "INSERT IGNORE INTO usuarios (id_usuario, nombre, email, password_hash, rol) "
        "VALUES (1, 'Admin Test', 'admin@test.com', 'x', 'admin')"
    )
    db_conn.commit()


def _seed_mesa_con_pedidos(db_conn, totales: list[float], estado="listo"):
    """Crea una mesa nueva (numero único) con un pedido por cada total en `totales`,
    cada uno con una línea de detalle consistente con ese total. Devuelve
    (id_mesa, numero, [id_pedido, ...])."""
    numero = int(uuid.uuid4().int % 1_000_000) + 1
    cur = db_conn.cursor(dictionary=True)

    cur.execute("INSERT INTO categorias (nombre) VALUES (%s)", (f"cat-{numero}",))
    id_categoria = cur.lastrowid
    cur.execute(
        "INSERT INTO productos (id_categoria, nombre, precio) VALUES (%s, %s, %s)",
        (id_categoria, f"prod-{numero}", 100.00),
    )
    id_producto = cur.lastrowid

    cur.execute("INSERT INTO mesas (numero) VALUES (%s)", (numero,))
    id_mesa = cur.lastrowid

    ids_pedido = []
    for total in totales:
        cur.execute(
            "INSERT INTO pedidos (id_mesa, estado, total) VALUES (%s, %s, %s)",
            (id_mesa, estado, total),
        )
        id_pedido = cur.lastrowid
        ids_pedido.append(id_pedido)
        cantidad = 1
        cur.execute(
            """
            INSERT INTO detalle_pedidos (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (id_pedido, id_producto, cantidad, total, total),
        )

    db_conn.commit()
    return id_mesa, numero, ids_pedido


def _seed_producto_con_stock(db_conn, stock_inicial=10, stock_minimo=2):
    numero = int(uuid.uuid4().int % 1_000_000) + 1
    cur = db_conn.cursor(dictionary=True)
    cur.execute("INSERT INTO categorias (nombre) VALUES (%s)", (f"cat-stock-{numero}",))
    id_categoria = cur.lastrowid
    cur.execute(
        """
        INSERT INTO productos (id_categoria, nombre, precio, stock_actual, stock_minimo)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (id_categoria, f"prod-stock-{numero}", 100.00, stock_inicial, stock_minimo),
    )
    id_producto = cur.lastrowid
    db_conn.commit()
    return id_producto


def _seed_mesa_con_pedido_de_producto(db_conn, id_producto, cantidad, precio_unitario, estado):
    numero = int(uuid.uuid4().int % 1_000_000) + 1
    cur = db_conn.cursor(dictionary=True)
    cur.execute("INSERT INTO mesas (numero) VALUES (%s)", (numero,))
    id_mesa = cur.lastrowid
    total = cantidad * precio_unitario
    cur.execute(
        "INSERT INTO pedidos (id_mesa, estado, total) VALUES (%s, %s, %s)",
        (id_mesa, estado, total),
    )
    id_pedido = cur.lastrowid
    cur.execute(
        """
        INSERT INTO detalle_pedidos (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (id_pedido, id_producto, cantidad, precio_unitario, total),
    )
    db_conn.commit()
    return id_mesa, numero, id_pedido


def _stock_actual(db_conn, id_producto) -> int:
    cur = db_conn.cursor()
    cur.execute("SELECT stock_actual FROM productos WHERE id_producto = %s", (id_producto,))
    return cur.fetchone()[0]


def _mesa_esta_ocupada(db_conn, id_mesa) -> bool:
    """mesa_operational_state.release() borra la fila; si no existe, la mesa
    no está marcada ocupada en el estado operativo persistido."""
    cur = db_conn.cursor()
    cur.execute("SELECT ocupada FROM mesa_estado_operativo WHERE id_mesa = %s", (id_mesa,))
    row = cur.fetchone()
    return bool(row[0]) if row else False


def _contar_cierres(db_conn, id_mesa) -> int:
    cur = db_conn.cursor()
    cur.execute("SELECT COUNT(*) FROM cierres_mesa WHERE id_mesa = %s", (id_mesa,))
    return cur.fetchone()[0]


def _estado_pedido(db_conn, id_pedido) -> str:
    cur = db_conn.cursor()
    cur.execute("SELECT estado FROM pedidos WHERE id_pedido = %s", (id_pedido,))
    return cur.fetchone()[0]


# ── 1. El total se recalcula en backend, no se confía en el cliente ──────────

def test_total_se_recalcula_desde_pedidos_no_desde_cliente(db_conn, client, admin_token):
    _seed_admin_usuario(db_conn)
    id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [1500.00, 2500.00])

    resp = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 4000.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    assert resp.status_code == 200
    body = resp.json()
    # 4000.0 es la suma real de los pedidos (1500 + 2500), no un valor que el
    # cliente pueda inyectar: CierreMesaCreate no tiene campo "total".
    assert body["total_consumido"] == 4000.0
    assert body["vuelto"] == 0.0
    assert body["pedidos_incluidos"] == 2


# ── 2. Atomicidad: un fallo a mitad de transacción no deja nada a medias ─────

def test_fallo_a_mitad_de_transaccion_no_deja_nada_a_medias(db_conn, client, admin_token, monkeypatch):
    _seed_admin_usuario(db_conn)
    id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [1000.00, 2000.00])

    # Deja la mesa marcada "ocupada" en el caché operativo para comprobar que,
    # si el cierre falla, esa liberación tampoco llega a ejecutarse.
    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO mesa_estado_operativo (id_mesa, ocupada) VALUES (%s, TRUE)",
        (id_mesa,),
    )
    db_conn.commit()

    import app.database as database_module
    import app.routes.mesas as mesas_module

    real_get_db_connection = database_module.get_db_connection

    class FailingCursor:
        """Envuelve el cursor real; revienta en el 2do INSERT a cierre_pedidos
        para simular un fallo a mitad de la transacción (ej. timeout, bug)."""

        def __init__(self, real_cursor):
            self._cursor = real_cursor
            self._inserts_cierre_pedidos = 0

        def execute(self, query, params=None):
            if "INSERT INTO cierre_pedidos" in query:
                self._inserts_cierre_pedidos += 1
                if self._inserts_cierre_pedidos >= 2:
                    raise RuntimeError("Fallo simulado a mitad de transacción")
            return self._cursor.execute(query, params) if params is not None else self._cursor.execute(query)

        def __getattr__(self, name):
            return getattr(self._cursor, name)

    class FailingConnection:
        def __init__(self, real_connection):
            self._conn = real_connection

        def cursor(self, *args, **kwargs):
            return FailingCursor(self._conn.cursor(*args, **kwargs))

        def __getattr__(self, name):
            return getattr(self._conn, name)

    def patched_get_db_connection():
        real_conn = real_get_db_connection()
        return FailingConnection(real_conn) if real_conn else real_conn

    monkeypatch.setattr(mesas_module, "get_db_connection", patched_get_db_connection)

    resp = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 3000.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    assert resp.status_code == 500

    # Nada de lo que la transacción intentó escribir quedó persistido.
    assert _contar_cierres(db_conn, id_mesa) == 0
    for id_pedido in ids_pedido:
        assert _estado_pedido(db_conn, id_pedido) == "listo"

    # La liberación de mesa nunca se alcanzó (el código nunca llega a esa línea
    # si la transacción falla antes del commit): el registro operativo sigue igual.
    cur.execute("SELECT ocupada FROM mesa_estado_operativo WHERE id_mesa = %s", (id_mesa,))
    row = cur.fetchone()
    assert row is not None and bool(row[0]) is True


# ── 3. No-doble-cierre, incluso si la mesa quedó "ocupada" por un cleanup fallido ──

def test_no_doble_cierre_aunque_mesa_no_se_libero_por_cleanup_fallido(
    db_conn, client, admin_token, monkeypatch
):
    _seed_admin_usuario(db_conn)
    id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [1800.00])

    import app.routes.mesas as mesas_module

    # Simula que el cleanup posterior al commit (liberar mesa) falla en
    # silencio: la mesa queda "ocupada" después de un cierre exitoso.
    monkeypatch.setattr(mesas_module.mesa_operational_state, "release", lambda *_args, **_kw: None)
    monkeypatch.setattr(mesas_module.mesa_sessions, "force_release", lambda *_args, **_kw: None)

    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO mesa_estado_operativo (id_mesa, ocupada) VALUES (%s, TRUE)",
        (id_mesa,),
    )
    db_conn.commit()

    primer_cierre = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 1800.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert primer_cierre.status_code == 200
    assert _contar_cierres(db_conn, id_mesa) == 1

    # La mesa sigue "ocupada" (el cleanup fue no-op) — exactamente el escenario
    # que se quiere blindar: ¿la guarda anti-doble-cierre depende de eso?
    cur.execute("SELECT ocupada FROM mesa_estado_operativo WHERE id_mesa = %s", (id_mesa,))
    assert bool(cur.fetchone()[0]) is True

    segundo_cierre = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 1800.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    assert segundo_cierre.status_code == 409
    # Ningún segundo registro financiero se creó: la guarda no depende del
    # estado operativo de la mesa, depende de cierre_pedidos (ya linkeados).
    assert _contar_cierres(db_conn, id_mesa) == 1


# ── 4. Validación de método de pago ──────────────────────────────────────────

def test_metodo_pago_invalido_devuelve_400(db_conn, client, admin_token):
    _seed_admin_usuario(db_conn)
    id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [500.00])

    resp = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "bitcoin", "monto_cobrado": 500.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    assert resp.status_code == 400
    assert _contar_cierres(db_conn, id_mesa) == 0


# ── 5. Cobro y entrega son ejes independientes ───────────────────────────────

def test_cobrar_mesa_con_pedido_en_preparacion_no_fuerza_entrega_y_libera_mesa(
    db_conn, client, admin_token
):
    _seed_admin_usuario(db_conn)
    id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [1000.00], estado="en_preparacion")
    id_pedido = ids_pedido[0]

    # La mesa está marcada ocupada antes del cobro, como en un caso real.
    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO mesa_estado_operativo (id_mesa, ocupada) VALUES (%s, TRUE)",
        (id_mesa,),
    )
    db_conn.commit()

    resp = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 1000.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    assert resp.status_code == 200
    assert resp.json()["entrega_pendiente"] is True

    # El pedido sigue con su estado real de cocina: cobrar no lo fuerza a "entregado".
    assert _estado_pedido(db_conn, id_pedido) == "en_preparacion"

    # Pero ya quedó vinculado a un cierre (está "cobrado").
    cur.execute("SELECT COUNT(*) FROM cierre_pedidos WHERE id_pedido = %s", (id_pedido,))
    assert cur.fetchone()[0] == 1

    # Y la mesa se liberó igual, pese a tener un pedido sin entregar.
    assert _mesa_esta_ocupada(db_conn, id_mesa) is False


def test_mesa_cobrada_se_puede_liberar_aunque_tenga_pedidos_sin_entregar(
    db_conn, client, admin_token
):
    _seed_admin_usuario(db_conn)
    id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [800.00], estado="listo")

    cierre = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 800.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert cierre.status_code == 200

    # El pedido sigue "listo" (no entregado) pero la mesa ya está cobrada;
    # liberar no debe rechazarla con 409 por falta de entrega.
    assert _estado_pedido(db_conn, ids_pedido[0]) == "listo"

    resp = client.post(
        f"/mesas/{id_mesa}/liberar",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200


def test_stock_no_se_descuenta_al_cobrar_solo_al_entregar_pedido_ya_cobrado(
    db_conn, client, admin_token
):
    _seed_admin_usuario(db_conn)
    id_producto = _seed_producto_con_stock(db_conn, stock_inicial=10)
    id_mesa, _, id_pedido = _seed_mesa_con_pedido_de_producto(
        db_conn, id_producto, cantidad=3, precio_unitario=100.0, estado="en_preparacion"
    )

    resp_cierre = client.post(
        f"/mesas/{id_mesa}/cerrar",
        json={"metodo_pago": "efectivo", "monto_cobrado": 300.0},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp_cierre.status_code == 200
    assert resp_cierre.json()["entrega_pendiente"] is True

    # Cobrar no descuenta stock ni cambia el estado del pedido.
    assert _estado_pedido(db_conn, id_pedido) == "en_preparacion"
    assert _stock_actual(db_conn, id_producto) == 10

    # El admin entrega el pedido directo desde 'en_preparacion' (conserva el atajo;
    # un mozo tendría que esperar a que cocina lo marque 'listo' — ver
    # TestMozoNoEntregaSinListo). Recién al entregar se descuenta stock, una vez.
    resp_entrega = client.patch(
        f"/pedidos/{id_pedido}/estado",
        json={"estado": "entregado"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp_entrega.status_code == 200

    # db_conn quedó en una transacción abierta (REPEATABLE READ) desde las
    # lecturas de arriba; sin este commit, las siguientes lecturas verían el
    # snapshot viejo y no el commit que hizo el PATCH en su propia conexión.
    db_conn.commit()
    assert _estado_pedido(db_conn, id_pedido) == "entregado"
    assert _stock_actual(db_conn, id_producto) == 7

    cur = db_conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM movimientos_stock WHERE id_pedido = %s AND tipo = 'salida'",
        (id_pedido,),
    )
    assert cur.fetchone()[0] == 1


# ── GET /mesas/{id}/operacion — semáforo de antigüedad (minutos_en_estado) ────

# Estos tests retroceden created_at hasta 40 min. Si falta menos de 45 min para
# medianoche, ese instante cae en el día anterior y el endpoint lo filtra por
# DATE(created_at) = CURDATE() — no es un bug del semáforo, es la ventana.
from datetime import datetime as _dt

_cerca_de_medianoche = pytest.mark.skipif(
    (_dt.now().hour, _dt.now().minute) < (0, 45),
    reason="a menos de 45 min de medianoche created_at retrocedido cae en ayer",
)


@_cerca_de_medianoche
class TestOperacionMinutosEnEstado:
    """minutos_en_estado mide la antigüedad del pedido DENTRO de su estado
    actual (no desde created_at). Alimenta el semáforo verde/amarillo/rojo
    del panel del mozo."""

    def test_en_preparacion_cuenta_desde_preparacion_at(self, db_conn, client, admin_token):
        id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [1000.00], estado="en_preparacion")
        cur = db_conn.cursor()
        # Creado hace 40 min, pero en preparación solo hace 25.
        cur.execute(
            "UPDATE pedidos SET created_at = NOW() - INTERVAL 40 MINUTE, "
            "confirmado_at = NOW() - INTERVAL 30 MINUTE, "
            "preparacion_at = NOW() - INTERVAL 25 MINUTE WHERE id_pedido = %s",
            (ids_pedido[0],),
        )
        db_conn.commit()

        resp = client.get(
            f"/mesas/{id_mesa}/operacion",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        pedido = next(p for p in resp.json()["pedidos"] if p["id_pedido"] == ids_pedido[0])
        assert pedido["minutos_espera"] >= 39          # desde created_at
        assert 24 <= pedido["minutos_en_estado"] <= 26  # desde preparacion_at

    def test_pendiente_cuenta_desde_created_at(self, db_conn, client, admin_token):
        id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [500.00], estado="pendiente")
        cur = db_conn.cursor()
        cur.execute(
            "UPDATE pedidos SET created_at = NOW() - INTERVAL 8 MINUTE WHERE id_pedido = %s",
            (ids_pedido[0],),
        )
        db_conn.commit()

        resp = client.get(
            f"/mesas/{id_mesa}/operacion",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        pedido = next(p for p in resp.json()["pedidos"] if p["id_pedido"] == ids_pedido[0])
        assert 7 <= pedido["minutos_en_estado"] <= 9

    def test_en_preparacion_sin_preparacion_at_cae_a_confirmado_o_created(self, db_conn, client, admin_token):
        id_mesa, _, ids_pedido = _seed_mesa_con_pedidos(db_conn, [700.00], estado="en_preparacion")
        cur = db_conn.cursor()
        cur.execute(
            "UPDATE pedidos SET created_at = NOW() - INTERVAL 15 MINUTE, "
            "confirmado_at = NULL, preparacion_at = NULL WHERE id_pedido = %s",
            (ids_pedido[0],),
        )
        db_conn.commit()

        resp = client.get(
            f"/mesas/{id_mesa}/operacion",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        pedido = next(p for p in resp.json()["pedidos"] if p["id_pedido"] == ids_pedido[0])
        assert 14 <= pedido["minutos_en_estado"] <= 16  # COALESCE cae a created_at


# ── PATCH /pedidos/{id}/estado — el mozo no entrega sin que cocina marque listo ─

def _seed_mozo_usuario(db_conn):
    cur = db_conn.cursor()
    cur.execute(
        "INSERT IGNORE INTO usuarios (id_usuario, nombre, email, password_hash, rol) "
        "VALUES (2, 'Mozo Test', 'mozo@test.com', 'x', 'mozo')"
    )
    db_conn.commit()


class TestMozoNoEntregaSinListo:
    """El mozo solo puede marcar 'entregado' desde 'listo' (cocina tiene que
    confirmar). El admin conserva el atajo directo como escape hatch."""

    def _patch(self, client, token, id_pedido, estado):
        return client.patch(
            f"/pedidos/{id_pedido}/estado",
            json={"estado": estado},
            headers={"Authorization": f"Bearer {token}"},
        )

    def test_mozo_no_entrega_desde_en_preparacion(self, db_conn, client, mozo_token):
        # El 409 corta antes de cualquier escritura, así que no hace falta stock.
        _, _, ids = _seed_mesa_con_pedidos(db_conn, [500.00], estado="en_preparacion")
        resp = self._patch(client, mozo_token, ids[0], "entregado")
        assert resp.status_code == 409
        assert _estado_pedido(db_conn, ids[0]) == "en_preparacion"

    def test_mozo_no_entrega_desde_confirmado(self, db_conn, client, mozo_token):
        _, _, ids = _seed_mesa_con_pedidos(db_conn, [500.00], estado="confirmado")
        resp = self._patch(client, mozo_token, ids[0], "entregado")
        assert resp.status_code == 409

    def test_mozo_si_entrega_desde_listo(self, db_conn, client, mozo_token):
        _seed_mozo_usuario(db_conn)
        id_producto = _seed_producto_con_stock(db_conn, stock_inicial=10)
        _, _, id_pedido = _seed_mesa_con_pedido_de_producto(
            db_conn, id_producto, cantidad=2, precio_unitario=100.0, estado="listo"
        )
        resp = self._patch(client, mozo_token, id_pedido, "entregado")
        assert resp.status_code == 200
        db_conn.commit()
        assert _estado_pedido(db_conn, id_pedido) == "entregado"
        assert _stock_actual(db_conn, id_producto) == 8  # recién ahora se descuenta

    def test_admin_conserva_el_atajo_directo_desde_en_preparacion(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_producto = _seed_producto_con_stock(db_conn, stock_inicial=10)
        _, _, id_pedido = _seed_mesa_con_pedido_de_producto(
            db_conn, id_producto, cantidad=1, precio_unitario=100.0, estado="en_preparacion"
        )
        resp = self._patch(client, admin_token, id_pedido, "entregado")
        assert resp.status_code == 200


# ── POST /mesas/{id}/cerrar — propina (migración 015) ────────────────────────
# La propina es un eje INDEPENDIENTE: el cliente paga la cuenta y deja la
# propina aparte. No entra en monto_cobrado ni afecta el vuelto.

def _cierre_de_mesa(db_conn, id_mesa):
    cur = db_conn.cursor(dictionary=True)
    cur.execute(
        "SELECT total_consumido, monto_cobrado, vuelto, propina "
        "FROM cierres_mesa WHERE id_mesa = %s ORDER BY id_cierre DESC LIMIT 1",
        (id_mesa,),
    )
    return cur.fetchone()


class TestCierrePropina:
    def test_propina_no_afecta_el_vuelto(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [450.00])
        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 500.0, "propina": 80.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["propina"] == 80.0
        assert body["vuelto"] == 50.0  # 500 - 450, la propina no descuenta
        db_conn.commit()
        fila = _cierre_de_mesa(db_conn, id_mesa)
        assert float(fila["propina"]) == 80.0
        assert float(fila["vuelto"]) == 50.0

    def test_tarjeta_paga_el_total_y_propina_aparte(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [1000.00])
        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "tarjeta", "monto_cobrado": 1000.0, "propina": 150.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["propina"] == 150.0
        assert resp.json()["vuelto"] == 0.0

    def test_propina_puede_ser_cualquier_monto_positivo(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [500.00])
        # propina mayor que "lo recibido por encima del total" → ya no es error
        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 500.0, "propina": 300.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["propina"] == 300.0
        assert resp.json()["vuelto"] == 0.0

    def test_sin_propina_default_cero(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [300.00])
        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 300.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["propina"] == 0.0
        db_conn.commit()
        assert float(_cierre_de_mesa(db_conn, id_mesa)["propina"]) == 0.0

    def test_propina_negativa_da_400(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [500.00])
        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 600.0, "propina": -10.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 400


class TestAsignacionSeLimpiaAlCerrar:
    """mesas.id_mozo_asignado (migración 016) es por ciclo: cobrar o liberar
    la mesa lo deja en NULL."""

    def _asignado(self, db_conn, id_mesa):
        cur = db_conn.cursor()
        cur.execute("SELECT id_mozo_asignado FROM mesas WHERE id_mesa = %s", (id_mesa,))
        return cur.fetchone()[0]

    def test_cobrar_limpia_la_asignacion(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        id_mesa, _, _ = _seed_mesa_con_pedidos(db_conn, [500.00])
        db_conn.cursor().execute(
            "UPDATE mesas SET id_mozo_asignado = 1 WHERE id_mesa = %s", (id_mesa,)
        )
        db_conn.commit()

        resp = client.post(
            f"/mesas/{id_mesa}/cerrar",
            json={"metodo_pago": "efectivo", "monto_cobrado": 500.0},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        db_conn.commit()
        assert self._asignado(db_conn, id_mesa) is None

    def test_liberar_limpia_la_asignacion(self, db_conn, client, admin_token):
        _seed_admin_usuario(db_conn)
        # Mesa sin pedidos sin cobrar → liberar directo.
        id_mesa, _, ids = _seed_mesa_con_pedidos(db_conn, [100.00])
        cur = db_conn.cursor()
        cur.execute("INSERT INTO cierres_mesa (id_mesa, numero_mesa, metodo_pago, total_consumido, monto_cobrado, vuelto, id_usuario_cierre) VALUES (%s, 0, 'efectivo', 100, 100, 0, 1)", (id_mesa,))
        id_cierre = cur.lastrowid
        cur.execute("INSERT INTO cierre_pedidos (id_cierre, id_pedido, total_pedido) VALUES (%s, %s, 100)", (id_cierre, ids[0]))
        cur.execute("UPDATE mesas SET id_mozo_asignado = 1 WHERE id_mesa = %s", (id_mesa,))
        db_conn.commit()

        resp = client.post(
            f"/mesas/{id_mesa}/liberar",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        db_conn.commit()
        assert self._asignado(db_conn, id_mesa) is None
