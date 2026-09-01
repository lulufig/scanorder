"""
Caja: rendición del efectivo y vista consolidada.

- GET  /caja/mia              — los cobros del usuario actual en un día (mozo/admin).
- GET  /caja/resumen          — foto de toda la caja del día (solo admin).
- POST /caja/cobros/{id}/rendir — marcar/desmarcar un cobro en efectivo como
  "efectivo entregado a caja". El mozo solo sus cobros; el admin cualquiera.

Todo sale de `cierres_mesa`. La rendición es por cobro (no por turno): migración
017 agregó `rendido_at` / `rendido_por`. Solo aplica a `metodo_pago = 'efectivo'`.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel

from app.database import close_db_connection, get_db_connection
from app.utils.dependencies import require_role

router = APIRouter(prefix="/caja", tags=["Caja"])

_col_cache: dict[str, bool] = {}


def _tabla_existe(cursor, tabla: str) -> bool:
    key = f"table.{tabla}"
    if key not in _col_cache:
        cursor.execute("SHOW TABLES LIKE %s", (tabla,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


def _columna_existe(cursor, tabla: str, columna: str) -> bool:
    key = f"{tabla}.{columna}"
    if key not in _col_cache:
        cursor.execute(f"SHOW COLUMNS FROM {tabla} LIKE %s", (columna,))
        _col_cache[key] = cursor.fetchone() is not None
    return _col_cache[key]


class RendirBody(BaseModel):
    rendido: bool = True


def _campos_cierre(cursor):
    """Devuelve (col_propina_sql, col_rendido_sql) según qué migraciones estén."""
    prop = "c.propina" if _columna_existe(cursor, "cierres_mesa", "propina") else "0 AS propina"
    rend = (
        "c.rendido_at"
        if _columna_existe(cursor, "cierres_mesa", "rendido_at")
        else "NULL AS rendido_at"
    )
    return prop, rend


@router.get("/mia")
def caja_mia(
    fecha: date = Query(None, description="Día a consultar (YYYY-MM-DD). Por defecto hoy."),
    current_user: dict = Depends(require_role("mozo", "admin")),
):
    """Los cobros que hizo el usuario actual en un día. El mozo lo usa para saber
    cuánto efectivo le queda por entregar a caja."""
    dia = fecha or date.today()
    id_usuario = current_user.get("user_id")

    vacio = {
        "fecha": dia.isoformat(),
        "resumen": {
            "mesas_cobradas": 0, "total_cobrado": 0.0, "propinas": 0.0,
            "efectivo_a_rendir": 0.0, "efectivo_rendido": 0.0,
            "efectivo_pendiente": 0.0, "por_metodo": {},
        },
        "cobros": [],
    }

    connection = get_db_connection()
    if not connection:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Error al conectar con la base de datos")
    try:
        cursor = connection.cursor(dictionary=True)
        if not _tabla_existe(cursor, "cierres_mesa"):
            return vacio
        col_prop, col_rend = _campos_cierre(cursor)
        cursor.execute(
            f"""
            SELECT c.id_cierre, c.id_mesa, m.numero AS numero_mesa, c.metodo_pago,
                   c.total_consumido, c.vuelto, {col_prop}, {col_rend},
                   DATE_FORMAT(c.created_at, '%H:%i') AS hora
            FROM cierres_mesa c
            LEFT JOIN mesas m ON m.id_mesa = c.id_mesa
            WHERE c.id_usuario_cierre = %s AND DATE(c.created_at) = %s
            ORDER BY c.created_at ASC
            """,
            (id_usuario, dia),
        )
        rows = cursor.fetchall()

        por_metodo, cobros = {}, []
        total_cobrado = propinas = 0.0
        efectivo_a_rendir = efectivo_rendido = 0.0
        for r in rows:
            tc = float(r["total_consumido"] or 0)
            pr = float(r["propina"] or 0)
            metodo = r["metodo_pago"]
            rendido = r.get("rendido_at") is not None
            total_cobrado += tc
            propinas += pr
            por_metodo[metodo] = round(por_metodo.get(metodo, 0.0) + tc, 2)
            if metodo == "efectivo":
                efectivo_a_rendir += tc
                if rendido:
                    efectivo_rendido += tc
            cobros.append({
                "id_cierre": r["id_cierre"],
                "numero_mesa": int(r["numero_mesa"]) if r["numero_mesa"] else None,
                "metodo_pago": metodo,
                "total": round(tc, 2),
                "propina": round(pr, 2),
                "vuelto": round(float(r["vuelto"] or 0), 2),
                "hora": r["hora"],
                "rendido": rendido if metodo == "efectivo" else None,
            })

        return {
            "fecha": dia.isoformat(),
            "resumen": {
                "mesas_cobradas": len(cobros),
                "total_cobrado": round(total_cobrado, 2),
                "propinas": round(propinas, 2),
                "efectivo_a_rendir": round(efectivo_a_rendir, 2),
                "efectivo_rendido": round(efectivo_rendido, 2),
                "efectivo_pendiente": round(efectivo_a_rendir - efectivo_rendido, 2),
                "por_metodo": por_metodo,
            },
            "cobros": cobros,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Error al obtener la caja: {str(e)}")
    finally:
        cursor.close()
        close_db_connection(connection)


@router.get("/resumen")
def caja_resumen(
    fecha: date = Query(None, description="Día a consultar. Por defecto hoy."),
    current_user: dict = Depends(require_role("admin")),
):
    """Foto de toda la caja del día: totales por método + tabla por mozo con
    cuánto efectivo cobró, cuánto rindió y cuánto queda pendiente."""
    dia = fecha or date.today()
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Error al conectar con la base de datos")
    try:
        cursor = connection.cursor(dictionary=True)
        base = {
            "fecha": dia.isoformat(),
            "totales": {"efectivo": 0.0, "tarjeta": 0.0, "qr": 0.0, "otro": 0.0, "total": 0.0, "propinas": 0.0},
            "por_mozo": [],
        }
        if not _tabla_existe(cursor, "cierres_mesa"):
            return base

        col_prop, col_rend = _campos_cierre(cursor)
        cursor.execute(
            f"""
            SELECT c.id_usuario_cierre AS id_usuario, u.nombre, u.rol,
                   c.metodo_pago, c.total_consumido, {col_prop}, {col_rend}
            FROM cierres_mesa c
            LEFT JOIN usuarios u ON u.id_usuario = c.id_usuario_cierre
            WHERE DATE(c.created_at) = %s
            """,
            (dia,),
        )
        rows = cursor.fetchall()

        totales = dict(base["totales"])
        por_mozo: dict = {}
        for r in rows:
            tc = float(r["total_consumido"] or 0)
            pr = float(r["propina"] or 0)
            metodo = r["metodo_pago"]
            rendido = r.get("rendido_at") is not None
            totales[metodo] = round(totales.get(metodo, 0.0) + tc, 2)
            totales["total"] = round(totales["total"] + tc, 2)
            totales["propinas"] = round(totales["propinas"] + pr, 2)

            uid = r["id_usuario"]
            m = por_mozo.setdefault(uid, {
                "id_usuario": uid,
                "nombre": r["nombre"] or "—",
                "rol": r["rol"] or "—",
                "cobros": 0, "efectivo_cobrado": 0.0,
                "efectivo_rendido": 0.0, "otros_metodos": 0.0, "propinas": 0.0,
            })
            m["cobros"] += 1
            m["propinas"] = round(m["propinas"] + pr, 2)
            if metodo == "efectivo":
                m["efectivo_cobrado"] = round(m["efectivo_cobrado"] + tc, 2)
                if rendido:
                    m["efectivo_rendido"] = round(m["efectivo_rendido"] + tc, 2)
            else:
                m["otros_metodos"] = round(m["otros_metodos"] + tc, 2)

        filas = []
        for m in por_mozo.values():
            m["efectivo_pendiente"] = round(m["efectivo_cobrado"] - m["efectivo_rendido"], 2)
            filas.append(m)
        filas.sort(key=lambda f: (-f["efectivo_pendiente"], -f["efectivo_cobrado"], f["nombre"].lower()))

        return {"fecha": dia.isoformat(), "totales": totales, "por_mozo": filas}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Error al obtener el resumen de caja: {str(e)}")
    finally:
        cursor.close()
        close_db_connection(connection)


@router.post("/cobros/{id_cierre}/rendir")
def rendir_cobro(
    id_cierre: int,
    body: RendirBody,
    current_user: dict = Depends(require_role("mozo", "admin")),
):
    """Marca (o desmarca) un cobro en efectivo como 'efectivo entregado a caja'.
    El mozo solo puede tocar sus propios cobros; el admin, cualquiera."""
    connection = get_db_connection()
    if not connection:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Error al conectar con la base de datos")
    try:
        cursor = connection.cursor(dictionary=True)
        if not _columna_existe(cursor, "cierres_mesa", "rendido_at"):
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Ejecutá la migración 017_cierre_rendido.sql",
            )
        cursor.execute(
            "SELECT id_usuario_cierre, metodo_pago FROM cierres_mesa WHERE id_cierre = %s",
            (id_cierre,),
        )
        cierre = cursor.fetchone()
        if not cierre:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cobro no encontrado")
        if cierre["metodo_pago"] != "efectivo":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Solo los cobros en efectivo se rinden (tarjeta/QR van directo a la cuenta)",
            )
        es_admin = current_user.get("rol") == "admin"
        if not es_admin and cierre["id_usuario_cierre"] != current_user.get("user_id"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Solo podés rendir tus propios cobros",
            )

        if body.rendido:
            cursor.execute(
                "UPDATE cierres_mesa SET rendido_at = NOW(), rendido_por = %s WHERE id_cierre = %s",
                (current_user.get("user_id"), id_cierre),
            )
        else:
            cursor.execute(
                "UPDATE cierres_mesa SET rendido_at = NULL, rendido_por = NULL WHERE id_cierre = %s",
                (id_cierre,),
            )
        connection.commit()
        return {"id_cierre": id_cierre, "rendido": body.rendido}
    except HTTPException:
        connection.rollback()
        raise
    except Exception as e:
        connection.rollback()
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Error al rendir el cobro: {str(e)}")
    finally:
        cursor.close()
        close_db_connection(connection)
