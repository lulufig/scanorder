"""
Gestor de conexiones WebSocket del panel de cocina.
Singleton `manager` compartido entre pedidos.py (endpoint WS) y
services/mesa_sessions.py (notificaciones de carrito).
"""
from fastapi import WebSocket


class CocinaConnectionManager:
    """Gestiona conexiones WebSocket activas del panel de cocina."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for connection in disconnected:
            self.disconnect(connection)


manager = CocinaConnectionManager()
