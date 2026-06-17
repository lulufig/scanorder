"""
Carrito colaborativo por mesa (host/guest via WebSocket).
El estado en memoria se espeja a MySQL en cada mutación vía el repositorio.
Sobrevive reinicios del proceso (el carrito persiste, las conexiones WS no).
"""
from datetime import datetime, timezone

from fastapi import WebSocket

from app.repositories.mesa_state_repo import (
    delete_session_snapshot,
    load_session_snapshots,
    persist_session_snapshot,
)
from app.services.cocina_manager import manager as cocina_manager


class MesaSessionManager:
    """Mantiene carritos colaborativos activos por mesa mientras corre el servidor."""

    def __init__(self):
        self.sessions: dict[str, dict] = {}

    def session_key(self, numero_mesa: int, qr_token: str | None) -> str:
        return f"{numero_mesa}:{qr_token or ''}"

    def get_session(self, key: str) -> dict | None:
        return self.sessions.get(key)

    def activity_snapshot(self) -> list[dict]:
        now = datetime.now(timezone.utc)
        snapshot = []
        for session in self.sessions.values():
            created_at = session.get("created_at") or now
            last_activity_at = session.get("last_activity_at") or created_at
            carrito = session.get("carrito") or []
            snapshot.append(
                {
                    "mesa": session["mesa"],
                    "participantes": len(session.get("clients") or {}),
                    "items_carrito": sum(
                        int(item.get("cantidad") or 0) for item in carrito
                    ),
                    "total_carrito": sum(
                        float(item.get("precio") or 0)
                        * int(item.get("cantidad") or 0)
                        for item in carrito
                    ),
                    "observaciones": session.get("observaciones") or "",
                    "created_at": created_at.isoformat(),
                    "last_activity_at": last_activity_at.isoformat(),
                    "minutos_desde_scan": int(
                        (now - created_at).total_seconds() // 60
                    ),
                    "minutos_sin_actividad": int(
                        (now - last_activity_at).total_seconds() // 60
                    ),
                }
            )
        persisted = load_session_snapshots()
        memory_tables = {int(item["mesa"]): item for item in snapshot}
        for item in persisted:
            memory_tables.setdefault(int(item["mesa"]), item)
        return list(memory_tables.values())

    def _snapshot(self, key: str, event: str = "snapshot") -> dict:
        session = self.sessions[key]
        return {
            "type": event,
            "mesa": session["mesa"],
            "host_client_id": session["host_client_id"],
            "participantes": [
                {"client_id": cid, "nombre": data["nombre"]}
                for cid, data in session["clients"].items()
            ],
            "carrito": session["carrito"],
            "observaciones": session["observaciones"],
        }

    async def connect(
        self,
        websocket: WebSocket,
        key: str,
        numero_mesa: int,
        client_id: str,
        nombre: str,
    ):
        await websocket.accept()
        session = self.sessions.setdefault(
            key,
            {
                "mesa": numero_mesa,
                "host_client_id": client_id,
                "clients": {},
                "carrito": [],
                "observaciones": "",
                "created_at": datetime.now(timezone.utc),
                "last_activity_at": datetime.now(timezone.utc),
            },
        )

        if not session["clients"]:
            session["host_client_id"] = client_id

        session["clients"][client_id] = {
            "nombre": nombre or "Cliente",
            "websocket": websocket,
        }
        session["last_activity_at"] = datetime.now(timezone.utc)
        persist_session_snapshot(key, session)
        await websocket.send_json(self._snapshot(key))
        await self.broadcast(
            key, self._snapshot(key, "participantes_actualizados"), exclude=client_id
        )
        await cocina_manager.broadcast(
            {
                "type": "mesa_sesion_actualizada",
                "mesa": numero_mesa,
                "participantes": len(session.get("clients") or {}),
                "items_carrito": sum(
                    int(item.get("cantidad") or 0)
                    for item in session.get("carrito") or []
                ),
                "message": f"Mesa {numero_mesa}: sesión colaborativa actualizada",
            }
        )

    def disconnect(self, key: str, client_id: str):
        session = self.sessions.get(key)
        if not session:
            return

        session["clients"].pop(client_id, None)
        if session["clients"] and session["host_client_id"] == client_id:
            session["host_client_id"] = next(iter(session["clients"].keys()))
        if not session["clients"] and not session["carrito"]:
            self.sessions.pop(key, None)
            delete_session_snapshot(key)
        else:
            persist_session_snapshot(key, session)

    async def broadcast(self, key: str, message: dict, exclude: str | None = None):
        session = self.sessions.get(key)
        if not session:
            return

        disconnected = []
        for client_id, data in session["clients"].items():
            if exclude and client_id == exclude:
                continue
            try:
                await data["websocket"].send_json(message)
            except Exception:
                disconnected.append(client_id)

        for client_id in disconnected:
            self.disconnect(key, client_id)

    async def update_cart(
        self, key: str, carrito: list[dict], observaciones: str | None
    ):
        session = self.sessions.get(key)
        if not session:
            return
        session["carrito"] = carrito
        session["observaciones"] = observaciones or ""
        session["last_activity_at"] = datetime.now(timezone.utc)
        persist_session_snapshot(key, session)
        await self.broadcast(key, self._snapshot(key, "carrito_actualizado"))
        await cocina_manager.broadcast(
            {
                "type": "mesa_carrito_actualizado",
                "mesa": session["mesa"],
                "participantes": len(session.get("clients") or {}),
                "items_carrito": sum(
                    int(item.get("cantidad") or 0) for item in carrito
                ),
                "total_carrito": sum(
                    float(item.get("precio") or 0) * int(item.get("cantidad") or 0)
                    for item in carrito
                ),
                "message": f"Mesa {session['mesa']}: carrito actualizado",
            }
        )

    async def clear_cart(self, key: str):
        session = self.sessions.get(key)
        if not session:
            return
        session["carrito"] = []
        session["observaciones"] = ""
        session["last_activity_at"] = datetime.now(timezone.utc)
        persist_session_snapshot(key, session)
        await self.broadcast(key, self._snapshot(key, "pedido_confirmado"))
        await cocina_manager.broadcast(
            {
                "type": "mesa_carrito_limpiado",
                "mesa": session["mesa"],
                "participantes": len(session.get("clients") or {}),
                "items_carrito": 0,
                "total_carrito": 0,
                "message": f"Mesa {session['mesa']}: carrito limpiado",
            }
        )

    def force_release(self, numero_mesa: int):
        """Elimina todas las sesiones activas de una mesa al cerrar la cuenta."""
        keys_to_remove = [
            key
            for key, session in self.sessions.items()
            if int(session.get("mesa", -1)) == int(numero_mesa)
        ]
        for key in keys_to_remove:
            self.sessions.pop(key, None)
            delete_session_snapshot(key)


mesa_sessions = MesaSessionManager()
