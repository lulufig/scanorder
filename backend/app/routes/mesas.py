from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.responses import FileResponse
from typing import List
import secrets

from app.database import get_db_connection, close_db_connection
from app.schemas.mesas import MesaCreate, MesaResponse
from app.utils.dependencies import require_role
from app.utils.qr import generate_qr, QR_DIR
from app.routes.pedidos import mesa_sessions, mesa_operational_state, pedidos_tiene_columna

router = APIRouter(
    prefix="/mesas",
    tags=["Mesas"]
)

_col_cache: dict[str, bool] = {}


def mesa_tiene_columna(cursor, columna: str) -> bool:
    """Indica si la tabla mesas tiene una columna determinada. Resultado cacheado por proceso."""
    key = f"mesas.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM mesas LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


@router.post("/", response_model=MesaResponse, status_code=status.HTTP_201_CREATED)
def create_mesa(
    mesa: MesaCreate,
    current_user: dict = Depends(require_role("admin"))
):
    """Crea una mesa, genera su QR y guarda la URL en la base de datos. Solo administradores."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_qr_token = mesa_tiene_columna(cursor, "qr_token")

        cursor.execute(
            "SELECT id_mesa FROM mesas WHERE numero = %s",
            (mesa.numero,)
        )
        if cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Ya existe una mesa con el número {mesa.numero}"
            )

        qr_token = secrets.token_urlsafe(24) if tiene_qr_token else None
        if tiene_qr_token:
            cursor.execute(
                "INSERT INTO mesas (numero, qr_token) VALUES (%s, %s)",
                (mesa.numero, qr_token)
            )
        else:
            cursor.execute(
                "INSERT INTO mesas (numero) VALUES (%s)",
                (mesa.numero,)
            )
        nueva_id = cursor.lastrowid

        qr_url = generate_qr(nueva_id, mesa.numero, qr_token)

        cursor.execute(
            "UPDATE mesas SET qr_url = %s WHERE id_mesa = %s",
            (qr_url, nueva_id)
        )
        connection.commit()

        cursor.execute(
            "SELECT * FROM mesas WHERE id_mesa = %s",
            (nueva_id,)
        )
        return cursor.fetchone()
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al crear mesa: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/", response_model=List[MesaResponse])
def listar_mesas():
    """Lista todas las mesas registradas."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_qr_token = mesa_tiene_columna(cursor, "qr_token")
        campo_token = ", qr_token" if tiene_qr_token else ", NULL AS qr_token"
        query = "SELECT id_mesa, numero, qr_url" + campo_token + " FROM mesas ORDER BY numero ASC"
        cursor.execute(query)
        return cursor.fetchall()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener mesas: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/mapa")
def mapa_mesas(current_user: dict = Depends(require_role("admin"))):
    """Devuelve el estado operativo de las mesas para el mapa visual del salón."""
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
            SELECT
              m.id_mesa,
              m.numero,
              m.qr_url,
              COALESCE(activos.pedidos_activos, 0) AS pedidos_activos,
              COALESCE(activos.total_activo, 0) AS total_activo,
              activos.primer_pedido_at,
              COALESCE(activos.pendientes, 0) AS pendientes,
              COALESCE(activos.confirmados, 0) AS confirmados,
              COALESCE(activos.en_preparacion, 0) AS en_preparacion,
              COALESCE(activos.listos, 0) AS listos,
              COALESCE(hoy.pedidos_hoy, 0) AS pedidos_hoy,
              COALESCE(hoy.total_hoy, 0) AS total_hoy
            FROM mesas m
            LEFT JOIN (
              SELECT
                id_mesa,
                COUNT(*) AS pedidos_activos,
                COALESCE(SUM(total), 0) AS total_activo,
                MIN(created_at) AS primer_pedido_at,
                SUM(estado = 'pendiente') AS pendientes,
                SUM(estado = 'confirmado') AS confirmados,
                SUM(estado = 'en_preparacion') AS en_preparacion,
                SUM(estado = 'listo') AS listos
              FROM pedidos
              WHERE estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo')
              GROUP BY id_mesa
            ) activos ON activos.id_mesa = m.id_mesa
            LEFT JOIN (
              SELECT
                id_mesa,
                COUNT(*) AS pedidos_hoy,
                COALESCE(SUM(total), 0) AS total_hoy
              FROM pedidos
              WHERE DATE(created_at) = CURDATE()
              GROUP BY id_mesa
            ) hoy ON hoy.id_mesa = m.id_mesa
            WHERE m.activa = TRUE
            ORDER BY m.numero ASC
            """
        )
        mesas = cursor.fetchall()
        sesiones_por_numero = {
            int(session["mesa"]): session
            for session in mesa_sessions.activity_snapshot()
        }
        estados_operativos = mesa_operational_state.snapshot()

        resultado = []
        for mesa in mesas:
            numero = int(mesa["numero"])
            session = sesiones_por_numero.get(numero)
            pedidos_activos = int(mesa["pedidos_activos"] or 0)
            estado_operativo = estados_operativos.get(int(mesa["id_mesa"])) or {}
            items_carrito = int(session["items_carrito"]) if session else 0
            participantes = int(session["participantes"]) if session else 0
            minutos_sin_actividad = int(session["minutos_sin_actividad"]) if session else None
            minutos_desde_scan = int(session["minutos_desde_scan"]) if session else None
            primer_pedido_at = mesa.get("primer_pedido_at")
            minutos_espera = None
            if primer_pedido_at:
                cursor.execute("SELECT TIMESTAMPDIFF(MINUTE, %s, NOW()) AS minutos", (primer_pedido_at,))
                minutos_espera = int((cursor.fetchone() or {}).get("minutos") or 0)

            abandonada = (
                session is not None
                and pedidos_activos == 0
                and items_carrito == 0
                and (minutos_desde_scan or 0) >= 10
            )

            if abandonada:
                estado_salon = "abandonada"
            elif estado_operativo.get("cuenta_solicitada"):
                estado_salon = "cuenta"
            elif pedidos_activos > 0 and (minutos_espera or 0) >= 20:
                estado_salon = "esperando"
            elif pedidos_activos > 0:
                estado_salon = "pedido_activo"
            elif items_carrito > 0:
                estado_salon = "pidiendo"
            elif participantes > 0 or estado_operativo.get("ocupada"):
                estado_salon = "ocupada"
            else:
                estado_salon = "libre"

            resultado.append({
                "id_mesa": mesa["id_mesa"],
                "numero": numero,
                "qr_url": mesa.get("qr_url"),
                "estado_salon": estado_salon,
                "pedidos_activos": pedidos_activos,
                "pendientes": int(mesa["pendientes"] or 0),
                "confirmados": int(mesa["confirmados"] or 0),
                "en_preparacion": int(mesa["en_preparacion"] or 0),
                "listos": int(mesa["listos"] or 0),
                "pedidos_hoy": int(mesa["pedidos_hoy"] or 0),
                "total_hoy": float(mesa["total_hoy"] or 0),
                "total_activo": float(mesa["total_activo"] or 0),
                "participantes": participantes,
                "items_carrito": items_carrito,
                "total_carrito": float(session["total_carrito"]) if session else 0,
                "minutos_espera": minutos_espera,
                "minutos_desde_scan": minutos_desde_scan,
                "minutos_sin_actividad": minutos_sin_actividad,
                "abandonada": abandonada,
                "cuenta_solicitada": bool(estado_operativo.get("cuenta_solicitada")),
                "mozo_solicitado": bool(estado_operativo.get("mozo_solicitado")),
            })

        return resultado

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener mapa de mesas: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/{id_mesa}/operacion")
def detalle_operacion_mesa(
    id_mesa: int,
    current_user: dict = Depends(require_role("admin"))
):
    """Detalle operativo de una mesa para administrarla desde el mapa."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )

    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT id_mesa, numero, qr_url FROM mesas WHERE id_mesa = %s",
            (id_mesa,)
        )
        mesa = cursor.fetchone()
        if not mesa:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mesa no encontrada")

        campos_observaciones = ", observaciones" if pedidos_tiene_columna(cursor, "observaciones") else ", NULL AS observaciones"
        cursor.execute(
            """
            SELECT id_pedido, id_mesa, estado, total, created_at AS fecha,
                   TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS minutos_espera
                   """ + campos_observaciones + """
            FROM pedidos
            WHERE id_mesa = %s
              AND estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo', 'entregado')
              AND DATE(created_at) = CURDATE()
            ORDER BY created_at DESC
            LIMIT 8
            """,
            (id_mesa,)
        )
        pedidos = cursor.fetchall()

        for pedido in pedidos:
            cursor.execute(
                """
                SELECT
                    dp.id_producto,
                    p.nombre,
                    dp.cantidad,
                    dp.subtotal,
                    c.nombre AS categoria,
                    p.subcategoria
                FROM detalle_pedidos dp
                JOIN productos p ON p.id_producto = dp.id_producto
                LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
                WHERE dp.id_pedido = %s
                """,
                (pedido["id_pedido"],)
            )
            pedido["detalle"] = cursor.fetchall()
            pedido["siguiente_estado"] = {
                "pendiente": "confirmado",
                "confirmado": "en_preparacion",
                "en_preparacion": "listo",
                "listo": "entregado",
            }.get(pedido["estado"])

        estado_operativo = mesa_operational_state.snapshot().get(id_mesa) or {}
        return {
            "mesa": mesa,
            "pedidos": pedidos,
            "cuenta_solicitada": bool(estado_operativo.get("cuenta_solicitada")),
            "mozo_solicitado": bool(estado_operativo.get("mozo_solicitado")),
            "ocupada": bool(estado_operativo.get("ocupada")),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener detalle de mesa: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.post("/{id_mesa}/liberar")
def liberar_mesa(
    id_mesa: int,
    current_user: dict = Depends(require_role("admin"))
):
    """Marca una mesa como cobrada/liberada en la vista operativa."""
    mesa_operational_state.release(id_mesa)
    return {"message": "Mesa liberada", "id_mesa": id_mesa}


@router.post("/{id_mesa}/atender-mozo")
def atender_solicitud_mozo(
    id_mesa: int,
    current_user: dict = Depends(require_role("admin"))
):
    """Marca como atendida la solicitud de mozo de una mesa."""
    mesa_operational_state.clear_service(id_mesa, "mozo")
    return {"message": "Solicitud de mozo atendida", "id_mesa": id_mesa}


@router.get("/{id_mesa}/qr")
def get_qr_mesa(id_mesa: int):
    """Retorna la imagen QR de la mesa como archivo descargable."""
    ruta_archivo = QR_DIR / f"mesa_{id_mesa}.png"

    if not ruta_archivo.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="QR no encontrado para esta mesa"
        )

    return FileResponse(
        path=str(ruta_archivo),
        media_type="image/png",
        filename=f"mesa_{id_mesa}.png"
    )


@router.post("/{id_mesa}/regenerar-qr", response_model=MesaResponse)
def regenerar_qr_mesa(
    id_mesa: int,
    current_user: dict = Depends(require_role("admin"))
):
    """Regenera el QR de una mesa existente y actualiza su URL en la base de datos. Solo administradores."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        tiene_qr_token = mesa_tiene_columna(cursor, "qr_token")

        cursor.execute(
            "SELECT * FROM mesas WHERE id_mesa = %s",
            (id_mesa,)
        )
        mesa = cursor.fetchone()
        if not mesa:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Mesa no encontrada"
            )

        qr_token = secrets.token_urlsafe(24) if tiene_qr_token else None
        qr_url = generate_qr(id_mesa, mesa["numero"], qr_token)

        if tiene_qr_token:
            cursor.execute(
                "UPDATE mesas SET qr_url = %s, qr_token = %s WHERE id_mesa = %s",
                (qr_url, qr_token, id_mesa)
            )
        else:
            cursor.execute(
                "UPDATE mesas SET qr_url = %s WHERE id_mesa = %s",
                (qr_url, id_mesa)
            )
        connection.commit()

        cursor.execute(
            "SELECT * FROM mesas WHERE id_mesa = %s",
            (id_mesa,)
        )
        return cursor.fetchone()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al regenerar QR: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)
