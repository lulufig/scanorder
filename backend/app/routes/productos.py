from fastapi import APIRouter, HTTPException, status, Depends
from typing import List

from app.database import get_db_connection, close_db_connection
from app.schemas.productos import ProductoCreate, ProductoUpdate, ProductoResponse
from app.utils.dependencies import require_role

router = APIRouter(
    prefix="/productos",
    tags=["Productos"]
)


@router.get("/", response_model=List[ProductoResponse])
def listar_productos():
    """Lista todos los productos con disponible = TRUE."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute("SELECT * FROM productos WHERE disponible = TRUE")
        return cursor.fetchall()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener productos: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/{id_producto}", response_model=ProductoResponse)
def get_producto(id_producto: int):
    """Retorna un producto por ID. Retorna 404 si no existe."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            "SELECT * FROM productos WHERE id_producto = %s",
            (id_producto,)
        )
        producto = cursor.fetchone()
        if not producto:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Producto no encontrado"
            )
        return producto
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener producto: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.post("/", response_model=ProductoResponse, status_code=status.HTTP_201_CREATED)
def create_producto(
    producto: ProductoCreate,
    current_user: dict = Depends(require_role("admin"))
):
    """Crea un nuevo producto. Solo administradores."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        query = """
            INSERT INTO productos (nombre, descripcion, precio, id_categoria, imagen_url, disponible)
            VALUES (%s, %s, %s, %s, %s, %s)
        """
        cursor.execute(query, (
            producto.nombre,
            producto.descripcion,
            producto.precio,
            producto.id_categoria,
            producto.imagen_url,
            producto.disponible
        ))
        connection.commit()

        nuevo_id = cursor.lastrowid
        cursor.execute(
            "SELECT * FROM productos WHERE id_producto = %s",
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
            detail=f"Error al crear producto: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.put("/{id_producto}", response_model=ProductoResponse)
def update_producto(
    id_producto: int,
    producto: ProductoUpdate,
    current_user: dict = Depends(require_role("admin"))
):
    """Actualiza un producto existente. Solo administradores. Campos no enviados no se modifican."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT * FROM productos WHERE id_producto = %s",
            (id_producto,)
        )
        existing = cursor.fetchone()
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Producto no encontrado"
            )

        # COALESCE preserva el valor actual cuando el campo llega como NULL
        query = """
            UPDATE productos
            SET
                nombre       = COALESCE(%s, nombre),
                descripcion  = COALESCE(%s, descripcion),
                precio       = COALESCE(%s, precio),
                id_categoria = COALESCE(%s, id_categoria),
                imagen_url   = COALESCE(%s, imagen_url),
                disponible   = COALESCE(%s, disponible)
            WHERE id_producto = %s
        """
        cursor.execute(query, (
            producto.nombre,
            producto.descripcion,
            producto.precio,
            producto.id_categoria,
            producto.imagen_url,
            producto.disponible,
            id_producto
        ))
        connection.commit()

        cursor.execute(
            "SELECT * FROM productos WHERE id_producto = %s",
            (id_producto,)
        )
        return cursor.fetchone()
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al actualizar producto: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)


@router.delete("/{id_producto}")
def delete_producto(
    id_producto: int,
    current_user: dict = Depends(require_role("admin"))
):
    """Eliminación lógica: marca disponible = FALSE. Solo administradores."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT id_producto FROM productos WHERE id_producto = %s",
            (id_producto,)
        )
        if not cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Producto no encontrado"
            )

        cursor.execute(
            "UPDATE productos SET disponible = FALSE WHERE id_producto = %s",
            (id_producto,)
        )
        connection.commit()

        return {"message": "Producto desactivado correctamente", "id_producto": id_producto}
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al eliminar producto: {str(e)}"
        )
    finally:
        cursor.close()
        close_db_connection(connection)
