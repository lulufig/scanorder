from fastapi import APIRouter, HTTPException, status, Depends, WebSocket, WebSocketDisconnect
from typing import List, Optional
from anyio import from_thread

from app.database import get_db_connection, close_db_connection
from app.schemas.pedidos import (
    PedidoCreate,
    PedidoResponse,
    PedidoCompletoResponse,
    EstadoUpdate,
)
from app.utils.dependencies import get_current_user
from app.utils.security import decode_access_token

router = APIRouter(
    prefix="/pedidos",
    tags=["Pedidos"]
)

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


def notificar_cocina(message: dict):
    """Envía una notificación a cocina sin bloquear la respuesta HTTP."""
    try:
        from_thread.run(manager.broadcast, message)
    except RuntimeError:
        pass


def pedidos_tiene_columna(cursor, columna: str) -> bool:
    """Indica si la tabla pedidos tiene una columna determinada."""
    cursor.execute("SHOW COLUMNS FROM pedidos LIKE %s", (columna,))
    return cursor.fetchone() is not None


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
        tiene_qr_token = False
        cursor.execute("SHOW COLUMNS FROM mesas LIKE %s", ("qr_token",))
        tiene_qr_token = cursor.fetchone() is not None

        # Validar que la mesa exista
        campos_mesa = "id_mesa, qr_token" if tiene_qr_token else "id_mesa, NULL AS qr_token"
        query_mesa = "SELECT " + campos_mesa + " FROM mesas WHERE id_mesa = %s"
        cursor.execute(query_mesa, (pedido.id_mesa,))
        mesa = cursor.fetchone()
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
                (pedido.id_mesa, total, observaciones)
            )
        else:
            cursor.execute(
                "INSERT INTO pedidos (id_mesa, total) VALUES (%s, %s)",
                (pedido.id_mesa, total)
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
        notificar_cocina({"type": "pedido_creado", "id_pedido": nuevo_id})
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
        query_listado = (
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + """
            FROM pedidos
            WHERE (%s IS NULL OR estado = %s)
            ORDER BY created_at DESC
            """
        )
        cursor.execute(
            query_listado,
            (estado, estado)
        )
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
