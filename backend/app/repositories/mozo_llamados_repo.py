"""
Persistencia de llamados de mozo / pedidos de cuenta (migración 014).

Complementa mesa_estado_operativo: los flags mozo_solicitado / cuenta_solicitada
siguen siendo la fuente de verdad de "hay un llamado abierto". Esta capa agrega
solo el timing (hace cuánto llamó la mesa) y la atribución (qué mozo lo tomó /
lo cerró).

Igual que mesa_state_repo: cada función abre y cierra su propia conexión y los
errores de DB se swallow silenciosamente — es best-effort. Si la migración 014
no está aplicada, todas las funciones degradan a no-op y el panel del mozo sigue
funcionando sin el cronómetro.
"""
from app.database import get_db_connection, close_db_connection


def _tabla_existe(cursor) -> bool:
    cursor.execute("SHOW TABLES LIKE %s", ("mozo_llamados",))
    return cursor.fetchone() is not None


def registrar_llamado(id_mesa: int, tipo: str) -> None:
    """Abre un llamado nuevo para la mesa. Cierra cualquier llamado previo que
    siguiera abierto (una mesa tiene un solo llamado a la vez, igual que el
    modelo de flag único de mesa_estado_operativo)."""
    if tipo not in ("mozo", "cuenta"):
        return
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor()
        if not _tabla_existe(cursor):
            return
        cursor.execute(
            """
            UPDATE mozo_llamados
               SET atendido_at = NOW()
             WHERE id_mesa = %s AND atendido_at IS NULL
            """,
            (int(id_mesa),),
        )
        cursor.execute(
            "INSERT INTO mozo_llamados (id_mesa, tipo) VALUES (%s, %s)",
            (int(id_mesa), tipo),
        )
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def tomar_llamado(id_mesa: int, id_usuario: int) -> bool:
    """Marca el llamado abierto de la mesa como 'tomado' por un mozo ("voy yo").
    Devuelve True si había un llamado abierto para tomar."""
    connection = get_db_connection()
    if not connection:
        return False
    try:
        cursor = connection.cursor()
        if not _tabla_existe(cursor):
            return False
        cursor.execute(
            """
            UPDATE mozo_llamados
               SET tomado_at = NOW(), tomado_por = %s
             WHERE id_mesa = %s AND atendido_at IS NULL
            """,
            (int(id_usuario), int(id_mesa)),
        )
        afectadas = cursor.rowcount
        connection.commit()
        return afectadas > 0
    except Exception:
        connection.rollback()
        return False
    finally:
        cursor.close()
        close_db_connection(connection)


def cerrar_llamado(id_mesa: int, tipo: str | None = None, id_usuario: int | None = None) -> None:
    """Cierra los llamados abiertos de la mesa (opcionalmente solo los de un tipo)."""
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor()
        if not _tabla_existe(cursor):
            return
        sql = "UPDATE mozo_llamados SET atendido_at = NOW(), atendido_por = %s WHERE id_mesa = %s AND atendido_at IS NULL"
        params = [id_usuario, int(id_mesa)]
        if tipo in ("mozo", "cuenta"):
            sql += " AND tipo = %s"
            params.append(tipo)
        cursor.execute(sql, tuple(params))
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def snapshot_llamados_abiertos() -> dict[int, dict]:
    """Devuelve {id_mesa: {tipo, minutos, tomado_por, tomado_por_nombre}} para
    todos los llamados sin cerrar. Lo consume GET /mesas/mapa."""
    connection = get_db_connection()
    if not connection:
        return {}
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor):
            return {}
        cursor.execute(
            """
            SELECT l.id_mesa,
                   l.tipo,
                   TIMESTAMPDIFF(MINUTE, l.solicitado_at, NOW()) AS minutos,
                   l.tomado_por,
                   u.nombre AS tomado_por_nombre
              FROM mozo_llamados l
              LEFT JOIN usuarios u ON u.id_usuario = l.tomado_por
             WHERE l.atendido_at IS NULL
             ORDER BY l.id_mesa, l.id_llamado DESC
            """
        )
        resultado: dict[int, dict] = {}
        for row in cursor.fetchall():
            id_mesa = int(row["id_mesa"])
            if id_mesa in resultado:
                continue  # el más reciente (id_llamado DESC) gana
            resultado[id_mesa] = {
                "tipo": row["tipo"],
                "minutos": int(row["minutos"] or 0),
                "tomado_por": row["tomado_por"],
                "tomado_por_nombre": row["tomado_por_nombre"],
            }
        return resultado
    except Exception:
        return {}
    finally:
        cursor.close()
        close_db_connection(connection)


def llamado_abierto(id_mesa: int) -> dict | None:
    """Llamado sin cerrar de una mesa puntual. Lo consume GET /mesas/{id}/operacion."""
    return snapshot_llamados_abiertos().get(int(id_mesa))
