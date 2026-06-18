import logging
from fastapi import APIRouter, HTTPException, status, Depends, WebSocket, WebSocketDisconnect
from typing import List, Optional
from anyio import from_thread

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
from app.services.cocina_manager import manager
from app.services.mesa_state import mesa_operational_state
from app.services.mesa_sessions import mesa_sessions
from app.services.notifications import notification_service

logger = logging.getLogger(__name__)

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

# Re-exportar clases para compatibilidad con tests de caracterización
# (los tests importan desde app.routes.pedidos)
from app.services.mesa_state import MesaOperationalState
from app.services.mesa_sessions import MesaSessionManager


def tabla_existe(cursor, tabla: str) -> bool:
    key = f"table.{tabla}"
    if key not in _col_cache:
        cursor.execute("SHOW TABLES LIKE %s", (tabla,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def productos_tiene_columna(cursor, columna: str) -> bool:
    key = f"productos.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM productos LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def pedidos_tiene_columna(cursor, columna: str) -> bool:
    key = f"pedidos.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM pedidos LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def mesas_tiene_qr_token(cursor) -> bool:
    key = "mesas.qr_token"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM mesas LIKE %s", ("qr_token",))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def mesas_tiene_columna(cursor, columna: str) -> bool:
    key = f"mesas.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM mesas LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def obtener_mesa_por_numero(cursor, numero_mesa: int):
    tiene_qr_token = mesas_tiene_qr_token(cursor)
    campos_mesa = "id_mesa, numero, qr_token" if tiene_qr_token else "id_mesa, numero, NULL AS qr_token"
    filtro_activa = " AND activa = TRUE" if mesas_tiene_columna(cursor, "activa") else ""
    query_mesa = "SELECT " + campos_mesa + " FROM mesas WHERE numero = %s" + filtro_activa
    cursor.execute(query_mesa, (numero_mesa,))
    return cursor.fetchone(), tiene_qr_token


def validate_qr_token(mesa: dict, tiene_qr_token: bool, token_aportado: str | None):
    """Lanza 403 si el token QR no coincide con el de la mesa.
    No hace nada si la columna qr_token no existe en la DB (degrada en silencio).
    """
    if tiene_qr_token and mesa.get("qr_token") and token_aportado != mesa["qr_token"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="QR inválido para esta mesa",
        )


def notificar_cocina(message: dict):
    """Envía una notificación a cocina sin bloquear la respuesta HTTP."""
    try:
        from_thread.run(manager.broadcast, message)
    except RuntimeError:
        pass


# ── WebSocket: panel de cocina ────────────────────────────────────────────────

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


# ── WebSocket: carrito colaborativo por mesa ──────────────────────────────────

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
                mesa_sessions._snapshot(session_key, "participantes_actualizados"),
            )
        notificar_cocina(
            {
                "type": "mesa_sesion_actualizada",
                "mesa": mesa,
                "message": f"Mesa {mesa}: participantes actualizados",
            }
        )


# ── HTTP: CRUD de pedidos ─────────────────────────────────────────────────────

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
            detail="El pedido debe contener al menos un producto",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")

        mesa, tiene_qr_token = obtener_mesa_por_numero(cursor, pedido.id_mesa)
        if not mesa:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Mesa {pedido.id_mesa} no encontrada",
            )
        validate_qr_token(mesa, tiene_qr_token, pedido.qr_token)

        items = []
        total = 0.0

        for item in pedido.productos:
            cursor.execute(
                "SELECT id_producto, nombre, precio, disponible FROM productos WHERE id_producto = %s",
                (item.id_producto,),
            )
            producto = cursor.fetchone()

            if not producto:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Producto {item.id_producto} no encontrado",
                )

            if not producto["disponible"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"El producto '{producto['nombre']}' no está disponible",
                )

            precio_unitario = float(producto["precio"])
            subtotal = precio_unitario * item.cantidad
            total += subtotal

            items.append(
                {
                    "id_producto": item.id_producto,
                    "cantidad": item.cantidad,
                    "precio_unitario": precio_unitario,
                    "subtotal": subtotal,
                }
            )

        observaciones = pedido.observaciones.strip() if pedido.observaciones else None
        if tiene_observaciones:
            cursor.execute(
                "INSERT INTO pedidos (id_mesa, total, observaciones) VALUES (%s, %s, %s)",
                (mesa["id_mesa"], total, observaciones),
            )
        else:
            cursor.execute(
                "INSERT INTO pedidos (id_mesa, total) VALUES (%s, %s)",
                (mesa["id_mesa"], total),
            )
        nuevo_id = cursor.lastrowid

        for item in items:
            cursor.execute(
                """
                INSERT INTO detalle_pedidos (id_pedido, id_producto, cantidad, precio_unitario, subtotal)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    nuevo_id,
                    item["id_producto"],
                    item["cantidad"],
                    item["precio_unitario"],
                    item["subtotal"],
                ),
            )

        connection.commit()

        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos WHERE id_pedido = %s",
            (nuevo_id,),
        )
        creado = cursor.fetchone()
        mesa_operational_state.touch(mesa["id_mesa"], ocupada=True, cuenta_solicitada=False)
        notificar_cocina(
            {
                "type": "pedido_creado",
                "id_pedido": nuevo_id,
                "id_mesa": mesa["id_mesa"],
                "numero_mesa": mesa["numero"],
                "message": f"Nuevo pedido: Mesa {mesa['numero']}",
            }
        )
        try:
            notification_service.notify({
                "type": "pedido_creado",
                "numero_mesa": mesa["numero"],
                "total": total,
                "id_pedido": nuevo_id,
            })
        except Exception as exc:
            logger.warning("Notificación pedido_creado falló (mesa %s): %s", mesa["numero"], exc)
        return creado

    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al crear pedido: {str(e)}",
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
            detail="Error al conectar con la base de datos",
        )

    try:
        cursor = connection.cursor(dictionary=True)
        mesa, tiene_qr_token = obtener_mesa_por_numero(cursor, servicio.id_mesa)
        if not mesa:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Mesa {servicio.id_mesa} no encontrada",
            )
        validate_qr_token(mesa, tiene_qr_token, servicio.qr_token)

        mensaje = "Mesa solicita mozo" if servicio.tipo == "mozo" else "Mesa solicita la cuenta"
        mesa_operational_state.touch(
            mesa["id_mesa"],
            ocupada=True,
            cuenta_solicitada=servicio.tipo == "cuenta",
            mozo_solicitado=servicio.tipo == "mozo",
        )
        notificar_cocina(
            {
                "type": "servicio_mesa",
                "tipo": servicio.tipo,
                "id_mesa": mesa["id_mesa"],
                "numero_mesa": mesa["numero"],
                "message": f"{mensaje}: Mesa {mesa['numero']}",
            }
        )
        try:
            notification_service.notify({
                "type": "servicio_mesa",
                "tipo": servicio.tipo,
                "numero_mesa": mesa["numero"],
            })
        except Exception as exc:
            logger.warning("Notificación servicio_mesa falló (mesa %s): %s", mesa["numero"], exc)

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
            detail=f"Error al solicitar servicio: {str(e)}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/", response_model=List[PedidoResponse])
def listar_pedidos(
    estado: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
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
            detail="Error al conectar con la base de datos",
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
            cursor.execute(
                select_base + "WHERE estado = %s ORDER BY created_at DESC", (estado,)
            )
        else:
            cursor.execute(
                select_base + "WHERE estado != 'entregado' ORDER BY created_at DESC"
            )
        return cursor.fetchall()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener pedidos: {str(e)}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/activos-completos", response_model=List[PedidoCompletoResponse])
def listar_pedidos_activos_completos(
    current_user: dict = Depends(get_current_user),
):
    """Lista pedidos activos con detalle en una sola respuesta para cocina/admin."""
    if current_user.get("rol") not in {"admin", "cocina"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo administración o cocina pueden consultar pedidos activos",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        campos_observaciones = (
            ", observaciones"
            if pedidos_tiene_columna(cursor, "observaciones")
            else ", NULL AS observaciones"
        )
        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + """
              FROM pedidos
              WHERE estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo')
              ORDER BY created_at DESC
            """
        )
        pedidos = cursor.fetchall()
        if not pedidos:
            return []

        ids = [pedido["id_pedido"] for pedido in pedidos]
        placeholders = ", ".join(["%s"] * len(ids))
        campo_subcategoria = (
            ", p.subcategoria"
            if productos_tiene_columna(cursor, "subcategoria")
            else ", NULL AS subcategoria"
        )
        cursor.execute(
            """
            SELECT
                dp.id_pedido,
                dp.id_producto,
                p.nombre,
                dp.cantidad,
                dp.subtotal,
                c.nombre AS categoria
                """
            + campo_subcategoria
            + f"""
            FROM detalle_pedidos dp
            JOIN productos p ON dp.id_producto = p.id_producto
            LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
            WHERE dp.id_pedido IN ({placeholders})
            ORDER BY dp.id_detalle ASC
            """,
            ids,
        )
        detalles_por_pedido = {id_pedido: [] for id_pedido in ids}
        for item in cursor.fetchall():
            detalles_por_pedido.setdefault(item["id_pedido"], []).append(
                {
                    "id_producto": item["id_producto"],
                    "nombre": item["nombre"],
                    "cantidad": item["cantidad"],
                    "subtotal": item["subtotal"],
                    "categoria": item.get("categoria"),
                    "subcategoria": item.get("subcategoria"),
                }
            )

        for pedido in pedidos:
            pedido["detalle"] = detalles_por_pedido.get(pedido["id_pedido"], [])
        return pedidos
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener pedidos activos: {str(e)}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/{id_pedido}", response_model=PedidoCompletoResponse)
def get_pedido(
    id_pedido: int,
    current_user: dict = Depends(get_current_user),
):
    """
    Retorna un pedido completo con su detalle de productos.
    Requiere autenticación.
    """
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_observaciones = pedidos_tiene_columna(cursor, "observaciones")
        campos_observaciones = ", observaciones" if tiene_observaciones else ", NULL AS observaciones"
        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha"
            + campos_observaciones
            + " FROM pedidos WHERE id_pedido = %s",
            (id_pedido,),
        )
        pedido = cursor.fetchone()

        if not pedido:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pedido no encontrado",
            )

        campo_subcategoria = (
            ", p.subcategoria"
            if productos_tiene_columna(cursor, "subcategoria")
            else ", NULL AS subcategoria"
        )
        cursor.execute(
            """
            SELECT
                dp.id_producto,
                p.nombre,
                dp.cantidad,
                dp.subtotal,
                c.nombre AS categoria
                """
            + campo_subcategoria
            + """
            FROM detalle_pedidos dp
            JOIN productos p ON dp.id_producto = p.id_producto
            LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
            WHERE dp.id_pedido = %s
            """,
            (id_pedido,),
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
            detail=f"Error al obtener pedido: {str(e)}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.patch("/{id_pedido}/estado", response_model=PedidoResponse)
def actualizar_estado_pedido(
    id_pedido: int,
    body: EstadoUpdate,
    current_user: dict = Depends(get_current_user),
):
    """
    Avanza el estado de un pedido: pendiente → en_preparacion → listo.
    No se permiten saltos ni retrocesos.
    Requiere usuario admin o cocina.
    """
    if current_user.get("rol") not in {"admin", "cocina"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo administración o cocina pueden actualizar pedidos",
        )

    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
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
            (id_pedido,),
        )
        pedido = cursor.fetchone()

        if not pedido:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pedido no encontrado",
            )

        estado_actual = pedido["estado"]
        siguiente_estado = TRANSICION_ESTADO.get(estado_actual)

        if siguiente_estado is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"El pedido ya está en estado final: '{estado_actual}'",
            )

        if body.estado != siguiente_estado:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Transición inválida. El siguiente estado para '{estado_actual}' es '{siguiente_estado}'",
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
            (*valores_update, id_pedido),
        )
        connection.commit()

        cursor.execute(query_pedido_actualizado, (id_pedido,))
        actualizado = cursor.fetchone()
        if actualizado:
            mesa_operational_state.touch(actualizado["id_mesa"], ocupada=True)
        notificar_cocina(
            {"type": "pedido_actualizado", "id_pedido": id_pedido, "estado": body.estado}
        )
        return actualizado
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al actualizar estado: {str(e)}",
        )
    finally:
        cursor.close()
        close_db_connection(connection)
