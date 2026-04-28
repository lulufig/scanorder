from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.responses import FileResponse
from typing import List

from app.database import get_db_connection, close_db_connection
from app.schemas.mesas import MesaCreate, MesaResponse
from app.utils.dependencies import require_role
from app.utils.qr import generate_qr, QR_DIR

router = APIRouter(
    prefix="/mesas",
    tags=["Mesas"]
)


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

        cursor.execute(
            "SELECT id_mesa FROM mesas WHERE numero = %s",
            (mesa.numero,)
        )
        if cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Ya existe una mesa con el número {mesa.numero}"
            )

        cursor.execute(
            "INSERT INTO mesas (numero) VALUES (%s)",
            (mesa.numero,)
        )
        nueva_id = cursor.lastrowid

        qr_url = generate_qr(nueva_id)

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
        cursor.execute("SELECT * FROM mesas ORDER BY numero ASC")
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

        cursor.execute(
            "SELECT * FROM mesas WHERE id_mesa = %s",
            (id_mesa,)
        )
        if not cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Mesa no encontrada"
            )

        qr_url = generate_qr(id_mesa)

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