from fastapi import APIRouter, HTTPException, status, Depends
from typing import List, Optional

from app.database import get_db_connection, close_db_connection
from app.schemas.pedidos import (
    PedidoCreate,
    PedidoResponse,
    PedidoCompletoResponse,
    EstadoUpdate,
)
from app.utils.dependencies import get_current_user

router = APIRouter(
    prefix="/pedidos",
    tags=["Pedidos"]
)

# Transiciones de estado permitidas en orden
TRANSICION_ESTADO = {
    "pendiente": "en_preparacion",
    "en_preparacion": "listo",
}


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

        # Validar que la mesa exista
        cursor.execute(
            "SELECT id_mesa FROM mesas WHERE id_mesa = %s",
            (pedido.id_mesa,)
        )
        if not cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Mesa {pedido.id_mesa} no encontrada"
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

        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha FROM pedidos WHERE id_pedido = %s",
            (nuevo_id,)
        )
        return cursor.fetchone()

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
        cursor.execute(
            """
            SELECT id_pedido, id_mesa, estado, total, created_at AS fecha
            FROM pedidos
            WHERE (%s IS NULL OR estado = %s)
            ORDER BY created_at DESC
            """,
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

        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha FROM pedidos WHERE id_pedido = %s",
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

        cursor.execute(
            "UPDATE pedidos SET estado = %s WHERE id_pedido = %s",
            (body.estado, id_pedido)
        )
        connection.commit()

        cursor.execute(
            "SELECT id_pedido, id_mesa, estado, total, created_at AS fecha FROM pedidos WHERE id_pedido = %s",
            (id_pedido,)
        )
        return cursor.fetchone()
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