from fastapi import APIRouter, HTTPException, status, Depends
from typing import List

from app.database import get_db_connection, close_db_connection
from app.schemas.productos import ProductoCreate, ProductoUpdate, ProductoResponse
from app.utils.dependencies import require_role

router = APIRouter(
    prefix="/productos",
    tags=["Productos"]
)


def resolver_id_categoria(cursor, id_categoria=None, categoria=None):
    """Resuelve el id_categoria desde un ID explícito o desde el nombre de categoría."""
    if id_categoria is not None:
        cursor.execute(
            "SELECT id_categoria FROM categorias WHERE id_categoria = %s AND activa = TRUE",
            (id_categoria,)
        )
        if not cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La categoría seleccionada no existe"
            )
        return id_categoria

    if categoria:
        aliases = {
            "papas": "Acompañamientos",
            "acompanamientos": "Acompañamientos",
            "acompañamientos": "Acompañamientos",
            "hamburguesas": "Hamburguesas",
            "bebidas": "Bebidas",
            "postres": "Postres",
            "combos": "Combos",
            "otros": "Otros",
        }
        aliases.update({
            "hamburguesa": "Comidas",
            "hamburguesas": "Comidas",
            "comida": "Comidas",
            "comidas": "Comidas",
            "papas": "Comidas",
            "acompanamientos": "Comidas",
            "combos": "Comidas",
            "cerveza": "Cervezas",
            "cervezas": "Cervezas",
            "birra": "Cervezas",
            "birras": "Cervezas",
            "bebida": "Cocteleria",
            "bebidas": "Cocteleria",
            "coctel": "Cocteleria",
            "cocteles": "Cocteleria",
            "cocteleria": "Cocteleria",
            "tragos": "Cocteleria",
            "postre": "Postres",
            "postres": "Postres",
        })
        categoria_busqueda = aliases.get(categoria.lower(), categoria)
        cursor.execute(
            "SELECT id_categoria FROM categorias WHERE LOWER(nombre) = LOWER(%s) AND activa = TRUE",
            (categoria_busqueda,)
        )
        row = cursor.fetchone()
        if row:
            return row["id_categoria"]

        cursor.execute(
            "INSERT INTO categorias (nombre) VALUES (%s)",
            (categoria_busqueda,)
        )
        return cursor.lastrowid

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Seleccioná una categoría válida"
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
        cursor.execute(
            """
            SELECT p.*, c.nombre AS categoria
            FROM productos p
            LEFT JOIN categorias c ON p.id_categoria = c.id_categoria
            WHERE p.disponible = TRUE
            """
        )
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


@router.get("/populares-hoy")
def productos_populares_hoy():
    """Devuelve productos mas pedidos del dia para recomendaciones publicas del menu QR."""
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
                p.id_producto,
                p.nombre,
                p.descripcion,
                p.precio,
                p.imagen_url,
                p.subcategoria,
                p.disponible,
                c.nombre AS categoria,
                SUM(dp.cantidad) AS total_pedido
            FROM detalle_pedidos dp
            JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
            JOIN productos p ON p.id_producto = dp.id_producto
            LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
            WHERE DATE(pe.created_at) = CURDATE()
              AND p.disponible = TRUE
            GROUP BY p.id_producto, p.nombre, p.descripcion, p.precio, p.imagen_url, p.subcategoria, p.disponible, c.nombre
            ORDER BY total_pedido DESC
            LIMIT 6
            """
        )
        populares = cursor.fetchall()
        return {
            "fecha": "hoy",
            "productos": populares,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener productos populares: {str(e)}"
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
            """
            SELECT p.*, c.nombre AS categoria
            FROM productos p
            LEFT JOIN categorias c ON p.id_categoria = c.id_categoria
            WHERE p.id_producto = %s
            """,
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
        id_categoria = resolver_id_categoria(
            cursor,
            id_categoria=producto.id_categoria,
            categoria=producto.categoria
        )
        query = """
            INSERT INTO productos (nombre, descripcion, precio, id_categoria, subcategoria, imagen_url, disponible)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """
        cursor.execute(query, (
            producto.nombre,
            producto.descripcion,
            producto.precio,
            id_categoria,
            producto.subcategoria,
            producto.imagen_url,
            producto.disponible
        ))
        connection.commit()

        nuevo_id = cursor.lastrowid
        cursor.execute(
            """
            SELECT p.*, c.nombre AS categoria
            FROM productos p
            LEFT JOIN categorias c ON p.id_categoria = c.id_categoria
            WHERE p.id_producto = %s
            """,
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

        id_categoria = existing["id_categoria"]
        if producto.id_categoria is not None or producto.categoria:
            id_categoria = resolver_id_categoria(
                cursor,
                id_categoria=producto.id_categoria,
                categoria=producto.categoria
            )

        campos_enviados = getattr(producto, "model_fields_set", getattr(producto, "__fields_set__", set()))
        subcategoria = producto.subcategoria if "subcategoria" in campos_enviados else existing.get("subcategoria")

        # COALESCE preserva campos no enviados; subcategoria se maneja aparte para permitir limpiarla.
        query = """
            UPDATE productos
            SET
                nombre       = COALESCE(%s, nombre),
                descripcion  = COALESCE(%s, descripcion),
                precio       = COALESCE(%s, precio),
                id_categoria = COALESCE(%s, id_categoria),
                subcategoria = %s,
                imagen_url   = COALESCE(%s, imagen_url),
                disponible   = COALESCE(%s, disponible)
            WHERE id_producto = %s
        """
        cursor.execute(query, (
            producto.nombre,
            producto.descripcion,
            producto.precio,
            id_categoria,
            subcategoria,
            producto.imagen_url,
            producto.disponible,
            id_producto
        ))
        connection.commit()

        cursor.execute(
            """
            SELECT p.*, c.nombre AS categoria
            FROM productos p
            LEFT JOIN categorias c ON p.id_categoria = c.id_categoria
            WHERE p.id_producto = %s
            """,
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
