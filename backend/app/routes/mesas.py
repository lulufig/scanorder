from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.responses import FileResponse
from typing import List
import secrets

from app.database import get_db_connection, close_db_connection
from app.schemas.mesas import MesaCreate, MesaResponse
from app.utils.dependencies import require_role
from app.utils.qr import generate_qr, QR_DIR

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
