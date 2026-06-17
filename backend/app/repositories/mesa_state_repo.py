"""
Persistencia de estado en caliente de mesas: estado operativo (ocupada/cuenta/mozo)
y snapshots de sesión de carrito colaborativo.

Cada función abre y cierra su propia conexión (sin pool gestionado). Los errores de DB
se swallow silenciosamente porque esta capa es best-effort: el estado primario vive en
memoria en los singletons de services/. Si la DB falla, la sesión se recarga al próximo
reinicio del proceso.
"""
import json
from datetime import datetime, timezone

from app.database import get_db_connection, close_db_connection


def _tabla_existe(cursor, tabla: str) -> bool:
    """Verifica si una tabla existe. Solo para uso interno de este módulo."""
    cursor.execute("SHOW TABLES LIKE %s", (tabla,))
    return cursor.fetchone() is not None


# ── Estado operativo de mesa ──────────────────────────────────────────────────

def persist_operational_state(id_mesa: int, updates: dict) -> None:
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_estado_operativo"):
            return
        cursor.execute(
            """
            INSERT INTO mesa_estado_operativo
                (id_mesa, ocupada, cuenta_solicitada, mozo_solicitado, last_activity_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON DUPLICATE KEY UPDATE
                ocupada = VALUES(ocupada),
                cuenta_solicitada = VALUES(cuenta_solicitada),
                mozo_solicitado = VALUES(mozo_solicitado),
                last_activity_at = NOW()
            """,
            (
                int(id_mesa),
                bool(updates.get("ocupada", True)),
                bool(updates.get("cuenta_solicitada", False)),
                bool(updates.get("mozo_solicitado", False)),
            ),
        )
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def release_operational_state(id_mesa: int) -> None:
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_estado_operativo"):
            return
        cursor.execute(
            "DELETE FROM mesa_estado_operativo WHERE id_mesa = %s", (int(id_mesa),)
        )
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def load_operational_snapshot() -> dict[int, dict]:
    connection = get_db_connection()
    if not connection:
        return {}
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_estado_operativo"):
            return {}
        cursor.execute(
            """
            SELECT id_mesa, ocupada, cuenta_solicitada, mozo_solicitado, last_activity_at
            FROM mesa_estado_operativo
            """
        )
        return {
            int(row["id_mesa"]): {
                "ocupada": bool(row["ocupada"]),
                "cuenta_solicitada": bool(row["cuenta_solicitada"]),
                "mozo_solicitado": bool(row["mozo_solicitado"]),
                "last_activity_at": row["last_activity_at"],
            }
            for row in cursor.fetchall()
        }
    except Exception:
        return {}
    finally:
        cursor.close()
        close_db_connection(connection)


# ── Snapshots de sesión de carrito colaborativo ───────────────────────────────

def persist_session_snapshot(key: str, session: dict) -> None:
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_sesiones_snapshot"):
            return
        cursor.execute(
            """
            INSERT INTO mesa_sesiones_snapshot
                (session_key, numero_mesa, host_client_id, participantes, carrito_json,
                 observaciones, created_at, last_activity_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                host_client_id = VALUES(host_client_id),
                participantes = VALUES(participantes),
                carrito_json = VALUES(carrito_json),
                observaciones = VALUES(observaciones),
                last_activity_at = VALUES(last_activity_at)
            """,
            (
                key,
                int(session["mesa"]),
                session.get("host_client_id"),
                len(session.get("clients") or {}),
                json.dumps(session.get("carrito") or [], ensure_ascii=False),
                session.get("observaciones") or "",
                session.get("created_at"),
                session.get("last_activity_at"),
            ),
        )
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def delete_session_snapshot(key: str) -> None:
    connection = get_db_connection()
    if not connection:
        return
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_sesiones_snapshot"):
            return
        cursor.execute(
            "DELETE FROM mesa_sesiones_snapshot WHERE session_key = %s", (key,)
        )
        connection.commit()
    except Exception:
        connection.rollback()
    finally:
        cursor.close()
        close_db_connection(connection)


def load_session_snapshots() -> list[dict]:
    connection = get_db_connection()
    if not connection:
        return []
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "mesa_sesiones_snapshot"):
            return []
        cursor.execute(
            """
            SELECT numero_mesa, participantes, carrito_json, observaciones,
                   created_at, last_activity_at
            FROM mesa_sesiones_snapshot
            """
        )
        now = datetime.now(timezone.utc)
        result = []
        for row in cursor.fetchall():
            created_at = row["created_at"]
            last_activity_at = row["last_activity_at"] or created_at
            if created_at and created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            if last_activity_at and last_activity_at.tzinfo is None:
                last_activity_at = last_activity_at.replace(tzinfo=timezone.utc)
            carrito = json.loads(row["carrito_json"] or "[]")
            result.append(
                {
                    "mesa": int(row["numero_mesa"]),
                    "participantes": int(row["participantes"] or 0),
                    "items_carrito": sum(
                        int(item.get("cantidad") or 0) for item in carrito
                    ),
                    "total_carrito": sum(
                        float(item.get("precio") or 0)
                        * int(item.get("cantidad") or 0)
                        for item in carrito
                    ),
                    "observaciones": row.get("observaciones") or "",
                    "created_at": created_at.isoformat() if created_at else "",
                    "last_activity_at": (
                        last_activity_at.isoformat() if last_activity_at else ""
                    ),
                    "minutos_desde_scan": (
                        int((now - created_at).total_seconds() // 60)
                        if created_at
                        else 0
                    ),
                    "minutos_sin_actividad": (
                        int((now - last_activity_at).total_seconds() // 60)
                        if last_activity_at
                        else 0
                    ),
                }
            )
        return result
    except Exception:
        return []
    finally:
        cursor.close()
        close_db_connection(connection)
