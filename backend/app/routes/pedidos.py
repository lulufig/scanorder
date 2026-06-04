from fastapi import APIRouter, HTTPException, status, Depends, WebSocket, WebSocketDisconnect
from typing import List, Optional
from anyio import from_thread
from datetime import datetime, timezone

from app.database import get_db_connection, close_db_connection
from app.schemas.pedidos import (
    PedidoCreate,
    PedidoResponse,
    PedidoCompletoResponse,
    EstadoUpdate,
    ServicioMesaCreate,
)
from app.utils.dependencies import get_current_user
from app.utils.security import decode_access_token

router = APIRouter(
    prefix="/pedidos",
    tags=["Pedidos"]
)

# Cache de columnas opcionales — se verifica una sola vez por proceso
_col_cache: dict[str, bool] = {}

# Transiciones de estado permitidas en orden
TRANSICION_ESTADO = {
    "pendiente": "confirmado",
    "confirmado": "en_preparacion",
    "en_preparacion": "listo",
    "listo": "entregado",
}


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


class MesaOperationalState:
    """Estado operativo liviano de salón mientras corre el servidor."""

    def __init__(self):
        self.states: dict[int, dict] = {}

    def touch(self, id_mesa: int, **updates):
        state = self.states.setdefault(
            int(id_mesa),
            {
                "ocupada": True,
                "cuenta_solicitada": False,
                "mozo_solicitado": False,
                "last_activity_at": datetime.now(timezone.utc),
            },
        )
        state.update(updates)
        state["last_activity_at"] = datetime.now(timezone.utc)

    def release(self, id_mesa: int):
        self.states.pop(int(id_mesa), None)

    def snapshot(self) -> dict[int, dict]:
        return self.states.copy()


mesa_operational_state = MesaOperationalState()


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
            snapshot.append({
                "mesa": session["mesa"],
                "participantes": len(session.get("clients") or {}),
                "items_carrito": sum(int(item.get("cantidad") or 0) for item in carrito),
                "total_carrito": sum(
                    float(item.get("precio") or 0) * int(item.get("cantidad") or 0)
                    for item in carrito
                ),
                "observaciones": session.get("observaciones") or "",
                "created_at": created_at.isoformat(),
                "last_activity_at": last_activity_at.isoformat(),
                "minutos_desde_scan": int((now - created_at).total_seconds() // 60),
                "minutos_sin_actividad": int((now - last_activity_at).total_seconds() // 60),
            })
        return snapshot

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
        await websocket.send_json(self._snapshot(key))
        await self.broadcast(key, self._snapshot(key, "participantes_actualizados"), exclude=client_id)

    def disconnect(self, key: str, client_id: str):
        session = self.sessions.get(key)
        if not session:
            return

        session["clients"].pop(client_id, None)
        if session["clients"] and session["host_client_id"] == client_id:
            session["host_client_id"] = next(iter(session["clients"].keys()))
        if not session["clients"] and not session["carrito"]:
            self.sessions.pop(key, None)

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

    async def update_cart(self, key: str, carrito: list[dict], observaciones: str | None):
        session = self.sessions.get(key)
        if not session:
            return
        session["carrito"] = carrito
        session["observaciones"] = observaciones or ""
        session["last_activity_at"] = datetime.now(timezone.utc)
        await self.broadcast(key, self._snapshot(key, "carrito_actualizado"))

    async def clear_cart(self, key: str):
        session = self.sessions.get(key)
        if not session:
            return
        session["carrito"] = []
        session["observaciones"] = ""
        session["last_activity_at"] = datetime.now(timezone.utc)
        await self.broadcast(key, self._snapshot(key, "pedido_confirmado"))


mesa_sessions = MesaSessionManager()


def notificar_cocina(message: dict):
    """Envía una notificación a cocina sin bloquear la respuesta HTTP."""
    try:
        from_thread.run(manager.broadcast, message)
    except RuntimeError:
        pass


def pedidos_tiene_columna(cursor, columna: str) -> bool:
    """Indica si la tabla pedidos tiene una columna determinada. Resultado cacheado por proceso."""
    key = f"pedidos.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM pedidos LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def mesas_tiene_qr_token(cursor) -> bool:
    """Indica si la tabla mesas tiene qr_token. Resultado cacheado por proceso."""
    key = "mesas.qr_token"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM mesas LIKE %s", ("qr_token",))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def obtener_mesa_por_numero(cursor, numero_mesa: int):
    tiene_qr_token = mesas_tiene_qr_token(cursor)
    campos_mesa = "id_mesa, numero, qr_token" if tiene_qr_token else "id_mesa, numero, NULL AS qr_token"
    query_mesa = "SELECT " + campos_mesa + " FROM mesas WHERE numero = %s AND activa = TRUE"
    cursor.execute(query_mesa, (numero_mesa,))
    return cursor.fetchone(), tiene_qr_token


@router.websocket("/ws/cocina")
async def websocket_cocina(websocket: WebSocket, token: str = ""):
    """Canal en tiempo real para avisar a cocina cuando cambian los pedidos."""
    payload = decode_access_token(token)
    if not payload or payload.get("rol") not in {"cocina", "admin"}:
        await websocket.close(code=1008)
        return

    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@router.websocket("/ws/mesa")
async def websocket_mesa(
    websocket: WebSocket,
    mesa: int,
    token: str = "",
    client_id: str = "",
    nombre: str = "Cliente",
):
    """Canal publico para sincronizar el carrito colaborativo de una mesa."""
    connection = get_db_connection()
    if not connection:
        await websocket.close(code=1011)
        return

    try:
        cursor = connection.cursor(dictionary=True)
        mesa_db, tiene_qr_token = obtener_mesa_por_numero(cursor, mesa)
        if not mesa_db:
            await websocket.close(code=1008)
            return

        if tiene_qr_token and mesa_db.get("qr_token") and token != mesa_db["qr_token"]:
            await websocket.close(code=1008)
            return
    finally:
        cursor.close()
        close_db_connection(connection)

    if not client_id:
        await websocket.close(code=1008)
        return

    session_key = mesa_sessions.session_key(mesa, token)
    await mesa_sessions.connect(websocket, session_key, mesa, client_id, nombre)

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "sync_cart":
                await mesa_sessions.update_cart(
                    session_key,
                    data.get("carrito") or [],
                    data.get("observaciones") or "",
                )
            elif action == "clear_cart":
                await mesa_sessions.clear_cart(session_key)
    except WebSocketDisconnect:
        mesa_sessions.disconnect(session_key, client_id)
        if mesa_sessions.get_session(session_key):
            await mesa_sessions.broadcast(
                session_key,
                mesa_sessions._snapshot(session_key, "participantes_actualizados")
            )


@router.post("/", response_model=PedidoResponse, status_code=status.HTTP_201_CREATED)
def create_pedido(pedido: PedidoCreate):
    """
    Crea un pedido desde el menú del cliente.
    Valida mesa, productos y disponibilidad. Calcula subtotales y total.
    No requiere autenticación (acceso por QR).
    """
    if not pedido.productos:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El pedido debe contener al menos un producto"
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")

        # Validar que la mesa exista. El frontend envia el numero visible de mesa.
        mesa, tiene_qr_token = obtener_mesa_por_numero(cursor, pedido.id_mesa)
        if not mesa:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Mesa {pedido.id_mesa} no encontrada"
            )
        if tiene_qr_token and mesa.get("qr_token") and pedido.qr_token != mesa["qr_token"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="QR inválido para esta mesa"
            )

        session_key = mesa_sessions.session_key(pedido.id_mesa, pedido.qr_token)
        session = mesa_sessions.get_session(session_key)
        if session and session.get("host_client_id") and pedido.client_id != session["host_client_id"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Solo el anfitrion de la mesa puede confirmar el pedido"
            )

        # Validar cada producto y armar los datos del detalle
        items = []
        total = 0.0

        for item in pedido.productos:
            cursor.execute(
                "SELECT id_producto, nombre, precio, disponible FROM productos WHERE id_producto = %s",
                (item.id_producto,)
            )
            producto = cursor.fetchone()

            if not producto:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Producto {item.id_producto} no encontrado"
                )

            if not producto["disponible"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"El producto '{producto['nombre']}' no está disponible"
                )

            precio_unitario = float(producto["precio"])
            subtotal = precio_unitario * item.cantidad
            total += subtotal

            items.append({
                "id_producto": item.id_producto,
                "cantidad": item.cantidad,
                "precio_unitario": precio_unitario,
                "subtotal": subtotal,
            })

        # Insertar cabecera del pedido
        observaciones = pedido.observaciones.strip() if pedido.observaciones else None
        if tiene_observaciones:
            cursor.execute(
                "INSERT INTO pedidos (id_mesa, total, observaciones) VALUES (%s, %s, %s)",
                (mesa["id_mesa"], total, observaciones)
            )
        else:
            cursor.execute(
                "INSERT INTO pedidos (id_mesa, total) VALUES (%s, %s)",
                (mesa["id_mesa"], total)
            )
        nuevo_id = cursor.lastrowid

        # Insertar cada línea de detalle
        for item in items:
            cursor.execute(
                """
                INSERT INTO detalle_pedidos (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (nuevo_id, item["id_producto"], item["cantidad"], item["precio_unitario"], item["subtotal"])
            )

        connection.commit()

        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        query_pedido_creado = (
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos WHERE id_pedido = %s"
        )
        cursor.execute(
            query_pedido_creado,
            (nuevo_id,)
        )
        creado = cursor.fetchone()
        mesa_operational_state.touch(mesa["id_mesa"], ocupada=True, cuenta_solicitada=False)
        notificar_cocina({
            "type": "pedido_creado",
            "id_pedido": nuevo_id,
            "id_mesa": mesa["id_mesa"],
            "numero_mesa": mesa["numero"],
            "message": f"Nuevo pedido: Mesa {mesa['numero']}",
        })
        return creado

    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al crear pedido: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.post("/servicio")
def solicitar_servicio(servicio: ServicioMesaCreate):
    """
    Notifica a cocina/salon que una mesa pidio mozo o cuenta.
    No requiere autenticacion porque se accede desde el QR de la mesa.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )

    try:
        cursor = connection.cursor(dictionary=True)
        mesa, tiene_qr_token = obtener_mesa_por_numero(cursor, servicio.id_mesa)
        if not mesa:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Mesa {servicio.id_mesa} no encontrada"
            )

        if tiene_qr_token and mesa.get("qr_token") and servicio.qr_token != mesa["qr_token"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="QR inválido para esta mesa"
            )

        mensaje = "Mesa solicita mozo" if servicio.tipo == "mozo" else "Mesa solicita la cuenta"
        mesa_operational_state.touch(
            mesa["id_mesa"],
            ocupada=True,
            cuenta_solicitada=servicio.tipo == "cuenta",
            mozo_solicitado=servicio.tipo == "mozo",
        )
        notificar_cocina({
            "type": "servicio_mesa",
            "tipo": servicio.tipo,
            "id_mesa": mesa["id_mesa"],
            "numero_mesa": mesa["numero"],
            "message": f"{mensaje}: Mesa {mesa['numero']}",
        })

        return {
            "message": mensaje,
            "mesa": mesa["numero"],
            "tipo": servicio.tipo,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al solicitar servicio: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/", response_model=List[PedidoResponse])
def listar_pedidos(
    estado: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """
    Lista todos los pedidos ordenados por fecha descendente.
    Acepta filtro opcional por estado: pendiente, en_preparacion, listo.
    Requiere autenticación.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")
        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        select_base = (
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos "
        )
        if estado:
            cursor.execute(select_base + "WHERE estado = %s ORDER BY created_at DESC", (estado,))
        else:
            # Sin filtro: devuelve todos los activos (excluye 'entregado')
            cursor.execute(select_base + "WHERE estado != 'entregado' ORDER BY created_at DESC")
        return cursor.fetchall()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener pedidos: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/{id_pedido}", response_model=PedidoCompletoResponse)
def get_pedido(
    id_pedido: int,
    current_user: dict = Depends(get_current_user)
):
    """
    Retorna un pedido completo con su detalle de productos.
    Requiere autenticación.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")
        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        query_pedido = (
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos WHERE id_pedido = %s"
        )

        cursor.execute(
            query_pedido,
            (id_pedido,)
        )
        pedido = cursor.fetchone()

        if not pedido:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pedido no encontrado"
            )

        cursor.execute(
            """
            SELECT dp.id_producto, p.nombre, dp.cantidad, dp.subtotal
            FROM detalle_pedidos dp
            JOIN productos p ON dp.id_producto = p.id_producto
            WHERE dp.id_pedido = %s
            """,
            (id_pedido,)
        )
        detalle = cursor.fetchall()

        return {
            "id_pedido": pedido["id_pedido"],
            "id_mesa": pedido["id_mesa"],
            "estado": pedido["estado"],
            "total": pedido["total"],
            "fecha": pedido["fecha"],
            "observaciones": pedido.get("observaciones"),
            "detalle": detalle,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener pedido: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.patch("/{id_pedido}/estado", response_model=PedidoResponse)
def actualizar_estado_pedido(
    id_pedido: int,
    body: EstadoUpdate,
    current_user: dict = Depends(get_current_user)
):
    """
    Avanza el estado de un pedido: pendiente → en_preparacion → listo.
    No se permiten saltos ni retrocesos.
    Requiere autenticación.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")
        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        query_pedido_actualizado = (
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos WHERE id_pedido = %s"
        )

        cursor.execute(
            "SELECT id_pedido, estado FROM pedidos WHERE id_pedido = %s",
            (id_pedido,)
        )
        pedido = cursor.fetchone()

        if not pedido:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pedido no encontrado"
            )

        estado_actual = pedido["estado"]
        siguiente_estado = TRANSICION_ESTADO.get(estado_actual)

        if siguiente_estado is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"El pedido ya está en estado final: '{estado_actual}'"
            )

        if body.estado != siguiente_estado:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Transición inválida. El siguiente estado para '{estado_actual}' es '{siguiente_estado}'"
            )

        campos_update = ["estado = %s"]
        valores_update = [body.estado]
        columnas_trazabilidad = {
            "confirmado": "confirmado_at",
            "en_preparacion": "preparacion_at",
            "listo": "listo_at",
            "entregado": "entregado_at",
        }
        columna_fecha = columnas_trazabilidad.get(body.estado)
        if columna_fecha and pedidos_tiene_columna(cursor, columna_fecha):
            campos_update.append(columna_fecha + " = NOW()")

        cursor.execute(
            "UPDATE pedidos SET " + ", ".join(campos_update) + " WHERE id_pedido = %s",
            (*valores_update, id_pedido)
        )
        connection.commit()

        cursor.execute(
            query_pedido_actualizado,
            (id_pedido,)
        )
        actualizado = cursor.fetchone()
        if actualizado:
            mesa_operational_state.touch(actualizado["id_mesa"], ocupada=True)
        notificar_cocina({
            "type": "pedido_actualizado",
            "id_pedido": id_pedido,
            "estado": body.estado
        })
        return actualizado
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al actualizar estado: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)
