from fastapi import APIRouter, HTTPException, status, Depends, Query
from typing import List, Optional

from app.database import get_db_connection, close_db_connection
from app.schemas.productos import ProductoCreate, ProductoUpdate, ProductoResponse
from app.utils.dependencies import require_role, get_current_user_optional
from app.utils.pagination import respuesta_paginada, normalizar_limit, offset as _offset

router = APIRouter(
    prefix="/productos",
    tags=["Productos"]
)

_col_cache: dict[str, bool] = {}


def producto_tiene_columna(cursor, columna: str) -> bool:
    key = f"productos.{columna}"
    if key not in _col_cache:
        cursor.execute("SHOW COLUMNS FROM productos LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def select_productos_sql(cursor) -> str:
    campo_subcategoria = "p.subcategoria" if producto_tiene_columna(cursor, "subcategoria") else "NULL AS subcategoria"
    campo_stock = "p.stock_actual" if producto_tiene_columna(cursor, "stock_actual") else "NULL AS stock_actual"
    campo_controla = "p.controla_stock" if producto_tiene_columna(cursor, "controla_stock") else "FALSE AS controla_stock"
    return f"""
            SELECT
                p.id_producto,
                p.id_categoria,
                p.nombre,
                p.descripcion,
                p.precio,
                {campo_subcategoria},
                p.imagen_url,
                p.disponible,
                {campo_stock},
                {campo_controla},
                c.nombre AS categoria,
                COALESCE((
                    SELECT SUM(dp.cantidad)
                    FROM detalle_pedidos dp
                    JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
                    WHERE dp.id_producto = p.id_producto
                      AND pe.estado <> 'cancelado'
                ), 0) AS total_vendido
            FROM productos p
            LEFT JOIN categorias c ON p.id_categoria = c.id_categoria
            """


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
            "hamburguesa": "Comidas",
            "hamburguesas": "Comidas",
            "comida": "Comidas",
            "comidas": "Comidas",
            "papas": "Comidas",
            "acompanamientos": "Comidas",
            "acompañamientos": "Comidas",
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
            "otros": "Otros",
        }
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
def listar_productos(
    incluir_no_disponibles: bool = Query(
        False,
        description="Si es true y quien llama es admin/mozo autenticado, incluye productos dados de baja.",
    ),
    current_user: Optional[dict] = Depends(get_current_user_optional),
):
    """Lista productos. Por defecto solo disponible = TRUE (menú público).
    Con incluir_no_disponibles=true y sesión admin/mozo válida, devuelve todos
    (usado por el panel admin para poder ver y reactivar productos dados de baja)."""
    mostrar_todos = incluir_no_disponibles and bool(
        current_user and current_user.get("rol") in {"admin", "mozo"}
    )
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos"
        )
    try:
        cursor = connection.cursor(dictionary=True)
        sql = select_productos_sql(cursor)
        if not mostrar_todos:
            sql += "WHERE p.disponible = TRUE"
        cursor.execute(sql)
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


_ORDEN_CATALOGO = {
    "mas-vendidos": "total_vendido DESC, p.id_producto DESC",
    "categoria":    "c.nombre IS NULL, c.nombre ASC, p.id_producto DESC",
    "recientes":    "p.id_producto DESC",
    "az":           "p.nombre ASC",
    "precio-asc":   "p.precio ASC, p.id_producto DESC",
    "precio-desc":  "p.precio DESC, p.id_producto DESC",
}


def _filtro_catalogo(cursor, q, estado, categoria):
    """Arma el WHERE compartido por el COUNT y el SELECT del catálogo paginado."""
    clauses, params = [], []
    if estado == "disponibles":
        clauses.append("p.disponible = TRUE")
    elif estado == "no-disponibles":
        clauses.append("p.disponible = FALSE")
    if categoria:
        clauses.append("c.nombre = %s")
        params.append(categoria)
    if q:
        like = f"%{q.strip()}%"
        campos = ["p.nombre LIKE %s", "p.descripcion LIKE %s", "c.nombre LIKE %s"]
        vals = [like, like, like]
        if producto_tiene_columna(cursor, "subcategoria"):
            campos.append("p.subcategoria LIKE %s")
            vals.append(like)
        clauses.append("(" + " OR ".join(campos) + ")")
        params.extend(vals)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


@router.get("/catalogo")
def catalogo_paginado(
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    q: Optional[str] = Query(None, description="Busca en nombre, descripción, categoría, subcategoría"),
    estado: str = Query("disponibles", description="disponibles | no-disponibles | todos"),
    categoria: Optional[str] = Query(None, description="Nombre exacto de categoría"),
    orden: str = Query("mas-vendidos", description="mas-vendidos | categoria | recientes | az | precio-asc | precio-desc"),
    current_user: dict = Depends(require_role("admin", "mozo")),
):
    """Catálogo de productos paginado para el panel admin (incluye los dados de baja).
    Devuelve `{items, total, page, limit, pages, resumen}` — `resumen` trae los
    contadores globales (total / disponibles / no_disponibles) para las tarjetas."""
    limit = normalizar_limit(limit)
    connection = get_db_connection()
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al conectar con la base de datos",
        )
    try:
        cursor = connection.cursor(dictionary=True)
        where, params = _filtro_catalogo(cursor, q, estado, categoria)
        order_by = _ORDEN_CATALOGO.get(orden, _ORDEN_CATALOGO["mas-vendidos"])

        cursor.execute(
            f"SELECT COUNT(*) AS total FROM productos p "
            f"LEFT JOIN categorias c ON p.id_categoria = c.id_categoria {where}",
            params,
        )
        total = cursor.fetchone()["total"]

        cursor.execute(
            select_productos_sql(cursor) + f"{where} ORDER BY {order_by} LIMIT %s OFFSET %s",
            [*params, limit, _offset(page, limit)],
        )
        items = cursor.fetchall()

        cursor.execute(
            "SELECT COUNT(*) AS total, COALESCE(SUM(disponible), 0) AS disponibles FROM productos"
        )
        r = cursor.fetchone()
        resumen = {
            "total": int(r["total"]),
            "disponibles": int(r["disponibles"]),
            "no_disponibles": int(r["total"]) - int(r["disponibles"]),
        }

        cursor.execute(
            "SELECT DISTINCT c.nombre AS nombre FROM categorias c "
            "JOIN productos p ON p.id_categoria = c.id_categoria "
            "WHERE c.nombre IS NOT NULL ORDER BY c.nombre"
        )
        categorias = [row["nombre"] for row in cursor.fetchall()]

        return respuesta_paginada(items, total, page, limit, resumen=resumen, categorias=categorias)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error al obtener el catálogo: {str(e)}",
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
        tiene_subcategoria = producto_tiene_columna(cursor, "subcategoria")
        tiene_stock = producto_tiene_columna(cursor, "stock_actual")
        campo_subcategoria = "p.subcategoria" if tiene_subcategoria else "NULL AS subcategoria"
        campo_stock = "p.stock_actual" if tiene_stock else "NULL AS stock_actual"
        group_subcategoria = ", p.subcategoria" if tiene_subcategoria else ""
        group_stock = ", p.stock_actual" if tiene_stock else ""
        filtro_stock = "AND p.stock_actual > 0" if tiene_stock else ""
        cursor.execute(
            f"""
            SELECT
                p.id_producto,
                p.nombre,
                p.descripcion,
                p.precio,
                p.imagen_url,
                {campo_subcategoria},
                {campo_stock},
                p.disponible,
                c.nombre AS categoria,
                SUM(dp.cantidad) AS total_pedido
            FROM detalle_pedidos dp
            JOIN pedidos pe ON pe.id_pedido = dp.id_pedido
            JOIN productos p ON p.id_producto = dp.id_producto
            LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
            WHERE DATE(pe.created_at) = CURDATE()
              AND p.disponible = TRUE
              {filtro_stock}
            GROUP BY p.id_producto, p.nombre, p.descripcion, p.precio, p.imagen_url{group_subcategoria}{group_stock}, p.disponible, c.nombre
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
        cursor.execute(select_productos_sql(cursor) + "WHERE p.id_producto = %s", (id_producto,))
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
        if producto_tiene_columna(cursor, "subcategoria"):
            query = """
                INSERT INTO productos (nombre, descripcion, precio, id_categoria, subcategoria, imagen_url, disponible)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """
            values = (
                producto.nombre,
                producto.descripcion,
                producto.precio,
                id_categoria,
                producto.subcategoria,
                producto.imagen_url,
                producto.disponible
            )
        else:
            query = """
                INSERT INTO productos (nombre, descripcion, precio, id_categoria, imagen_url, disponible)
                VALUES (%s, %s, %s, %s, %s, %s)
            """
            values = (
                producto.nombre,
                producto.descripcion,
                producto.precio,
                id_categoria,
                producto.imagen_url,
                producto.disponible
            )
        cursor.execute(query, values)
        nuevo_id = cursor.lastrowid

        # controla_stock: se aplica siempre el valor del alta (default TRUE en el
        # schema), así desmarcar el checkbox al crear también funciona.
        if producto_tiene_columna(cursor, "controla_stock"):
            cursor.execute(
                "UPDATE productos SET controla_stock = %s WHERE id_producto = %s",
                (bool(producto.controla_stock), nuevo_id),
            )

        connection.commit()

        cursor.execute(select_productos_sql(cursor) + "WHERE p.id_producto = %s", (nuevo_id,))
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
        tiene_subcategoria = producto_tiene_columna(cursor, "subcategoria")
        subcategoria = producto.subcategoria if "subcategoria" in campos_enviados else existing.get("subcategoria")

        campos_update = [
            "nombre = COALESCE(%s, nombre)",
            "descripcion = COALESCE(%s, descripcion)",
            "precio = COALESCE(%s, precio)",
            "id_categoria = COALESCE(%s, id_categoria)",
        ]
        values = [
            producto.nombre,
            producto.descripcion,
            producto.precio,
            id_categoria,
        ]
        if tiene_subcategoria:
            campos_update.append("subcategoria = %s")
            values.append(subcategoria)
        if "controla_stock" in campos_enviados and producto_tiene_columna(cursor, "controla_stock"):
            campos_update.append("controla_stock = %s")
            values.append(bool(producto.controla_stock))
        campos_update.extend([
            "imagen_url = COALESCE(%s, imagen_url)",
            "disponible = COALESCE(%s, disponible)",
        ])
        values.extend([producto.imagen_url, producto.disponible, id_producto])
        cursor.execute(
            "UPDATE productos SET " + ", ".join(campos_update) + " WHERE id_producto = %s",
            values
        )
        connection.commit()

        cursor.execute(select_productos_sql(cursor) + "WHERE p.id_producto = %s", (id_producto,))
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
