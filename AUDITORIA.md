# Auditoría de backend — ScanOrder

Fecha: 2026-06-16
Alcance: solo lectura. No se modificó código fuente.

---

## 1. Mapa de estructura real

```
backend/
├── .env                          (no versionado, ver sección 3)
├── requirements.txt               13 líneas
├── app/
│   ├── __init__.py                 0
│   ├── database.py                33   conexión MySQL (mysql-connector-python)
│   ├── main.py                     71   bootstrap FastAPI, CORS, routers
│   ├── routes/
│   │   ├── auth.py               185   registro/login/me
│   │   ├── mesas.py              849   CRUD mesas, mapa de salón, cuenta/cierre, QR
│   │   ├── pedidos.py           1100   pedidos + WS cocina + WS carrito colaborativo
│   │   ├── productos.py          401   CRUD productos/categorías
│   │   └── reportes.py           395   dashboard, ventas por hora, PDF de ventas
│   ├── schemas/
│   │   ├── auth.py                43
│   │   ├── mesas.py               57
│   │   ├── pedidos.py             55
│   │   └── productos.py           39
│   └── utils/
│       ├── dependencies.py        50   get_current_user / require_role
│       ├── qr.py                  58   generación de PNG QR
│       └── security.py            54   hash, JWT encode/decode
├── migrations/
│   ├── 001_fix_estados.sql        20   corrige tipo de columna estado (ENUM→VARCHAR) y repara filas con estado=''
│   ├── 002_menu_categorias_nuevas.sql  38
│   ├── 003_productos_subcategoria.sql  36
│   ├── 004_pedidos_trazabilidad.sql    21   agrega columnas confirmado_at/preparacion_at/listo_at/entregado_at
│   ├── 005_cierres_mesa.sql       73   tablas cierres_mesa / cierre_pedidos
│   └── 006_runtime_state.sql      23   tablas mesa_estado_operativo / mesa_sesiones_snapshot
├── static/qr/                     8 archivos PNG (mesas 1,2,3,9,10,11,12,13)
├── tests/
│   ├── conftest.py                11
│   ├── test_pedidos.py            34
│   └── test_productos.py          57
└── venv/                          entorno virtual versionado dentro del repo (no es código propio)

Total código propio (sin venv, sin .sql, sin tests): 3105 líneas
Total incluyendo migraciones y tests: 3716 líneas
```

`frontend/` es estático (HTML + JS vanilla, sin build): `admin/`, `cliente/`, `cocina/`, `auth/`, `home/`, `assets/`.

**Hallazgo colateral:** `backend/venv/` está presente en el árbol de archivos del repo (no en `.gitignore` aparentemente sin confirmar si está trackeado por git — ver nota abajo). Vale la pena revisar `git ls-files backend/venv | wc -l` si no se hizo antes; no se tocó nada al respecto en esta auditoría.

---

## 2. Verificación de supuestos del documento de producto

| # | Supuesto | Veredicto | Evidencia |
|---|----------|-----------|-----------|
| 1 | `pedidos.py` ~755 líneas, carrito colaborativo host/guest | **Parcialmente falso** | El archivo tiene **1100 líneas**, no 755 (+345, ~46% más grande que lo documentado). El carrito colaborativo host/guest sí existe y es real: clase `MesaSessionManager` ([pedidos.py:309-484](backend/app/routes/pedidos.py#L309-L484)), con noción de `host_client_id` que se reasigna si el host se desconecta ([pedidos.py:409-410](backend/app/routes/pedidos.py#L409-L410)). |
| 2 | WebSocket bidireccional | **Confirmado** | Dos canales WS reales: `/pedidos/ws/cocina` (push a cocina, [pedidos.py:530-543](backend/app/routes/pedidos.py#L530-L543)) y `/pedidos/ws/mesa` (bidireccional cliente↔servidor para sincronizar carrito, [pedidos.py:546-605](backend/app/routes/pedidos.py#L546-L605)). El cliente manda `action: sync_cart` / `clear_cart` y recibe `snapshot`, `carrito_actualizado`, `participantes_actualizados`, `pedido_confirmado`. |
| 3 | Detección de "mesa abandonada" | **Confirmado** | Calculada en `mapa_mesas()` ([mesas.py:238-243](backend/app/routes/mesas.py#L238-L243)): `abandonada = sesión activa AND sin pedidos activos AND carrito vacío AND ≥10 min desde el scan`. Es heurística en tiempo de request, no un timer/cron en background — se recalcula cada vez que se pide `/mesas/mapa`. |
| 4 | Token de seguridad por mesa en el QR | **Confirmado** | `qr_token` generado con `secrets.token_urlsafe(24)` al crear/regenerar mesa ([mesas.py:91](backend/app/routes/mesas.py#L91), [mesas.py:820](backend/app/routes/mesas.py#L820)), embebido en la URL del QR ([qr.py:48-50](backend/app/utils/qr.py#L48-L50)) y validado en `create_pedido`, `solicitar_servicio` y en el handshake del WS de mesa. Todo el chequeo es defensivo vía `mesas_tiene_qr_token()` — si la columna no existe en la DB, el sistema sigue funcionando sin token (degrada en silencio). |
| 5 | Generación de reportes PDF (ReportLab + BackgroundTasks) | **Confirmado, con matiz** | `reportes.py` usa ReportLab (`SimpleDocTemplate`, `Table`, etc., [reportes.py:8-11](backend/app/routes/reportes.py#L8-L11)) para `/reportes/ventas`. El archivo temporal se borra con `starlette.background.BackgroundTask(os.unlink, tmp.name)` ([reportes.py:206](backend/app/routes/reportes.py#L206)) — es `BackgroundTask` de Starlette (limpieza post-respuesta), **no** `fastapi.BackgroundTasks` para trabajo asíncrono/diferido. Es un detalle de nombre, no de arquitectura: el PDF se genera de forma síncrona dentro del request, bloqueando el worker mientras corre ReportLab. |
| 6 | Sesiones de mesa / carritos en memoria, se pierden al reiniciar | **Falso tal como está hoy** | Existe persistencia real en MySQL desde la migración `006_runtime_state.sql`: tablas `mesa_estado_operativo` y `mesa_sesiones_snapshot`. Cada mutación de `MesaSessionManager` y `MesaOperationalState` se espeja a DB (`persist_mesa_session_snapshot`, `persist_mesa_operational_state`, [pedidos.py:51-233](backend/app/routes/pedidos.py#L51-L233)). El diccionario en memoria (`self.sessions`, `self.states`) sigue siendo la fuente primaria en caliente (los WebSockets activos solo existen en memoria de proceso, eso es inevitable), pero el **estado de negocio** (carrito, participantes, ocupada/cuenta/mozo) se recupera desde DB tras un reinicio vía `load_mesa_session_snapshots()` / `load_mesa_operational_snapshot()`. Lo que sí se pierde al reiniciar: las conexiones WebSocket activas en sí (los clientes deben reconectar), no el contenido del carrito. |

**Conclusión clave para el roadmap:** el documento de producto describe una versión más temprana/simplificada del backend. La versión actual ya resolvió (parcialmente) el problema de pérdida de estado en memoria mediante snapshots a DB. Cualquier decisión de "eliminar por ser un parche en memoria" debe revisarse — ya no es un parche puramente volátil.

---

## 3. SECRET_KEY y variables de entorno

- Variables cargadas vía `python-dotenv`, `load_dotenv()` se llama en **tres lugares independientes**: [main.py:1-2](backend/app/main.py#L1-L2), [database.py:6-7](backend/app/database.py#L6-L7), [security.py:5-7](backend/app/utils/security.py#L5-L7). Es redundante (idempotente, no rompe nada) pero indica falta de un único punto de configuración.
- `SECRET_KEY` se lee en [security.py:15](backend/app/utils/security.py#L15) desde `os.getenv("SECRET_KEY")`. Si no está definida, **lanza `RuntimeError` al importar el módulo** ([security.py:19-20](backend/app/utils/security.py#L19-L20)) — falla rápido y explícito, correcto.
- Archivo real `backend/.env` (no versionado, confirmado con `git ls-files` y `git log --all -- backend/.env` → nunca estuvo en el historial de git, y `.gitignore` lo excluye desde el primer commit con el patrón `*.env`):
  - `SECRET_KEY=tu_clave_secreta_super_segura_cambiar_en_produccion_12345` — **valor de placeholder/desarrollo, no apto para producción** (es legible, predecible y aparentemente compartido en plantillas).
  - `DB_PASSWORD=` vacío (root sin password, típico de entorno local).
  - `DEBUG=True` — revisar que no quede así en producción (FastAPI no usa esta var directamente en `main.py`, pero conviene confirmar si algo más la lee).
  - `MENU_URL=http://192.168.1.9:5500/...` — IP de LAN hardcodeada en `.env` (no en código), usada para generar las URLs de los QR y para CORS automático ([main.py:27-33](backend/app/main.py#L27-L33)).
- No hay archivo `.env.example` en el repo — un desarrollador nuevo no tiene plantilla de qué variables necesita.
- Test suite fuerza sus propias env vars con `setdefault` en [conftest.py:9-11](backend/tests/conftest.py#L9-L11), evitando depender del `.env` real. Correcto.

---

## 4. Endpoints actuales (método, ruta, rol requerido)

### `auth.py` — prefix `/auth`
| Método | Ruta | Rol |
|---|---|---|
| POST | `/auth/register` | Público si no hay usuarios (bootstrap); si ya hay usuarios, requiere Bearer token de **admin** (chequeo manual con header, no usa `Depends`) |
| POST | `/auth/login` | Público |
| GET | `/auth/me` | Cualquier usuario autenticado |
| GET | `/auth/admin-only` | **admin** |

### `productos.py` — prefix `/productos`
| Método | Ruta | Rol |
|---|---|---|
| GET | `/productos/` | Público |
| GET | `/productos/populares-hoy` | Público |
| GET | `/productos/{id_producto}` | Público |
| POST | `/productos/` | **admin** |
| PUT | `/productos/{id_producto}` | **admin** |
| DELETE | `/productos/{id_producto}` (soft delete) | **admin** |

### `mesas.py` — prefix `/mesas`
| Método | Ruta | Rol |
|---|---|---|
| POST | `/mesas/` | **admin** |
| GET | `/mesas/` | **admin** |
| GET | `/mesas/mapa` | **admin** |
| GET | `/mesas/{id_mesa}/operacion` | **admin** |
| GET | `/mesas/{id_mesa}/cuenta` | **admin** |
| POST | `/mesas/{id_mesa}/cerrar` | **admin** |
| POST | `/mesas/{id_mesa}/liberar` | **admin** |
| POST | `/mesas/{id_mesa}/atender-mozo` | **admin** |
| GET | `/mesas/{id_mesa}/qr` | **admin** |
| POST | `/mesas/{id_mesa}/regenerar-qr` | **admin** |

### `pedidos.py` — prefix `/pedidos`
| Método | Ruta | Rol |
|---|---|---|
| WS | `/pedidos/ws/cocina` | **cocina** o **admin** (token validado dentro del handler, no vía `Depends`) |
| WS | `/pedidos/ws/mesa` | Público + validación de `qr_token` de la mesa (si la columna existe) |
| POST | `/pedidos/` | Público (acceso por QR) |
| POST | `/pedidos/servicio` | Público (acceso por QR) |
| GET | `/pedidos/` | Cualquier usuario autenticado |
| GET | `/pedidos/activos-completos` | **admin** o **cocina** |
| GET | `/pedidos/{id_pedido}` | Cualquier usuario autenticado |
| PATCH | `/pedidos/{id_pedido}/estado` | **admin** o **cocina** |

### `reportes.py` — prefix `/reportes`
| Método | Ruta | Rol |
|---|---|---|
| GET | `/reportes/ventas` (PDF) | **admin** |
| GET | `/reportes/dashboard` | **admin** |
| GET | `/reportes/ventas-hoy` | **admin** |

### `main.py`
| Método | Ruta | Rol |
|---|---|---|
| GET | `/` | Público |
| GET | `/health` | Público |

**Nota de seguridad menor:** en `/auth/register` y en los dos WebSockets, la validación de rol/token se hace a mano leyendo el header/query param en lugar de usar `Depends(require_role(...))` como el resto de rutas. Funciona, pero es una inconsistencia de patrón que vale la pena unificar si se toca ese archivo.

---

## 5. Mapa de riesgos: qué se rompe si se elimina cada feature

### A. Carrito colaborativo (host/guest vía WS `/pedidos/ws/mesa`)

**Backend que se va con esto:**
- `MesaSessionManager` completo (~175 líneas: [pedidos.py:309-484](backend/app/routes/pedidos.py#L309-L484))
- Funciones de persistencia asociadas: `persist_mesa_session_snapshot`, `delete_mesa_session_snapshot`, `load_mesa_session_snapshots` (~100 líneas: [pedidos.py:132-234](backend/app/routes/pedidos.py#L132-L234))
- El endpoint WS `/pedidos/ws/mesa` en sí ([pedidos.py:546-605](backend/app/routes/pedidos.py#L546-L605))
- Migración 006 (tabla `mesa_sesiones_snapshot`) quedaría huérfana
- `mesa_sessions.force_release()` se llama desde `cerrar_mesa` y `liberar_mesa` en `mesas.py` ([mesas.py:663](backend/app/routes/mesas.py#L663), [mesas.py:744](backend/app/routes/mesas.py#L744)) — **hay que quitar esas llamadas o stubbear el manager**
- `mesa_sessions.activity_snapshot()` alimenta directamente el cálculo de `items_carrito`, `participantes`, `total_carrito`, `minutos_desde_scan` y, por consecuencia directa, **el estado "abandonada"** en `mapa_mesas()` ([mesas.py:216-243](backend/app/routes/mesas.py#L216-L243)) → **acoplado con la feature C**

**Frontend que se rompe:**
- `frontend/cliente/menu.js` abre el WS, manda `sync_cart`/`clear_cart`, escucha `snapshot`/`carrito_actualizado`/`participantes_actualizados`/`pedido_confirmado` ([menu.js:1208-1340](frontend/cliente/menu.js#L1208-L1340)). Sin esto, el menú cliente pierde la sincronización en tiempo real entre comensales de la misma mesa — el carrito pasaría a ser puramente local (localStorage/estado de pestaña), lo cual puede ser aceptable si el roadmap apunta a "un cliente = un pedido" en vez de "mesa compartida".
- `frontend/admin/js/mesas.js` consume `participantes`, `items_carrito`, `total_carrito` del mapa de mesas para pintar el salón ([mesas.js](frontend/admin/js/mesas.js)) — quedarían en 0 siempre, hay que ajustar la UI o aceptar que esos campos desaparezcan.

**Riesgo:** Medio-alto. Es la feature más entrelazada con "mesa abandonada" y con el mapa de salón. Eliminarla a medias (solo el WS, dejando el cálculo de abandonada) rompe la detección de abandono, porque hoy depende de `session is not None` y `minutos_desde_scan` que vienen exclusivamente del `MesaSessionManager`.

---

### B. Mesa abandonada

**Backend:** Es solo cálculo derivado (~15 líneas, [mesas.py:238-258](backend/app/routes/mesas.py#L238-L258)), no hay timers, hilos en background ni cron — se recalcula en cada `GET /mesas/mapa`. Eliminarlo es trivial en el backend: borrar el bloque `abandonada = (...)` y el branch `if abandonada: estado_salon = "abandonada"`.

**Dependencia inversa:** depende 100% de la feature A (sesiones de mesa) para `session`, `items_carrito`, `minutos_desde_scan`. Si se elimina A primero, B ya queda muerto por sí solo (siempre `abandonada=False`).

**Frontend que se rompe:**
- `frontend/admin/js/mesas.js`: filtra alertas por `estado === "abandonada"` ([mesas.js:110](frontend/admin/js/mesas.js#L110), [mesas.js:202](frontend/admin/js/mesas.js#L202)) y tiene el label "Abandonada" en un diccionario de estados ([mesas.js:248](frontend/admin/js/mesas.js#L248)). Hay CSS asociado en `admin/css/mesas.css`. Si se quita del backend sin tocar el frontend, esos casos simplemente nunca se disparan (no rompe, solo queda código muerto en el frontend).

**Riesgo:** Bajo si se elimina junto con A. Si se elimina sola (dejando A), no tiene sentido porque sin sesiones activas tampoco se puede calcular "abandonada" de otra forma sin reintroducir algún tracking de actividad por mesa.

---

### C. Token de seguridad por QR (`qr_token`)

**Backend:**
- Generación: `secrets.token_urlsafe(24)` en creación/regeneración de mesa ([mesas.py:91](backend/app/routes/mesas.py#L91), [mesas.py:820](backend/app/routes/mesas.py#L820))
- Persistencia: columna `qr_token` en tabla `mesas` (gateada por feature-detection `mesas_tiene_qr_token()` — el código **ya soporta correr sin esta columna**, degradando solo el chequeo de seguridad)
- Validación en 3 puntos: `create_pedido` ([pedidos.py:638-642](backend/app/routes/pedidos.py#L638-L642)), `solicitar_servicio` ([pedidos.py:761-765](backend/app/routes/pedidos.py#L761-L765)), handshake de `/pedidos/ws/mesa` ([pedidos.py:567-569](backend/app/routes/pedidos.py#L567-L569))
- Usado también como parte del `session_key` del carrito colaborativo (`f"{numero_mesa}:{qr_token or ''}"`, [pedidos.py:315-316](backend/app/routes/pedidos.py#L315-L316)) → **acoplado con feature A**

**Frontend:**
- `menu.js` lee `?token=` de la URL del QR y lo manda en cada creación de pedido, en `servicio` y en la conexión WS ([menu.js:8](frontend/cliente/menu.js#L8), [menu.js:1131](frontend/cliente/menu.js#L1131), [menu.js:1209](frontend/cliente/menu.js#L1209), [menu.js:1338](frontend/cliente/menu.js#L1338)).

**Riesgo de eliminar:** Bajo desde el punto de vista de "no rompe nada técnicamente" — el código ya tiene fallback gracioso si la columna no existe. **Riesgo de seguridad si se elimina sin reemplazo:** cualquiera que adivine o vea el número de mesa (`?mesa=5`) puede hacer pedidos a esa mesa o abrir su WS sin restricción. Es la única barrera anti-suplantación de mesa que existe hoy. Si el roadmap lo quita, conviene documentar explícitamente que se acepta ese trade-off.

---

### D. Reportes PDF (ReportLab)

**Backend:** Único endpoint involucrado es `GET /reportes/ventas` (~165 líneas dedicadas a construir el PDF, [reportes.py:53-218](backend/app/routes/reportes.py#L53-L218)). No comparte estado con nada del resto del sistema — es la feature más aislada y fácil de remover de las cuatro. `dashboard` y `ventas-hoy` no dependen de ReportLab, son JSON puro.

**Dependencia de paquete:** `reportlab>=4.1.0` en `requirements.txt` — se puede retirar la dependencia entera si se borra este endpoint.

**Frontend:**
- `frontend/admin/js/index.js`: botón "Generar reporte de ventas" llama `GET /reportes/ventas?...` y descarga el PDF vía `downloadFile()` de `api.js` ([index.js:255-269](frontend/admin/js/index.js#L255-L269)). Si se borra el endpoint, ese botón rompe con un 404 — hay que quitar el botón/sección del dashboard admin también.

**Riesgo:** Bajo. Es la eliminación más limpia y autocontenida de las cuatro: un endpoint, una dependencia de paquete, un botón de frontend.

---

## 6. Resumen de acoplamientos (para secuenciar la eliminación si se decide)

```
Carrito colaborativo (A) ──┬──> Mesa abandonada (B)        [B muere solo si se quita A]
                            └──> session_key usa qr_token (C) [eliminar C rompe el namespacing de sesiones, no la feature en sí]

Token QR (C) ──> validación en create_pedido / servicio / ws_mesa (independiente de A/B,
                 solo se cruza con A en la construcción de session_key)

Reportes PDF (D) ──> sin dependencias cruzadas con A/B/C
```

**Orden de eliminación de menor a mayor impacto, si el roadmap decide remover features:**
1. **D (reportes PDF)** — aislado, bajo riesgo, hay que tocar 1 archivo backend + 1 botón frontend.
2. **A+B juntos (carrito colaborativo + mesa abandonada)** — deben ir juntos porque B depende de A. Tocan `pedidos.py`, `mesas.py`, migración 006, y dos archivos frontend (`menu.js`, `mesas.js`).
3. **C (token QR)** — técnicamente independiente, pero es la única protección de acceso por mesa; tratarlo como decisión de seguridad explícita, no como limpieza de código.

---

## 7. Discrepancias detectadas vs. el documento de producto

1. `pedidos.py` mide 1100 líneas, no ~755 — el documento describe un estado anterior del archivo.
2. El supuesto "todo en memoria, se pierde al reiniciar" ya no es cierto: existe persistencia a MySQL desde la migración 006 para sesiones de carrito y estado operativo de mesa. Solo las conexiones WebSocket en sí (no su contenido de negocio) son volátiles.
3. "BackgroundTasks" en el documento probablemente se refiere a `starlette.background.BackgroundTask`, que en el código se usa únicamente para borrar el archivo temporal del PDF después de enviarlo — no hay generación asíncrona/diferida de reportes.

## 8. Corrección (post-auditoría)

La fila de la migración `001_fix_estados.sql` en la sección 1 decía "columnas de trazabilidad de fecha por estado" — esa descripción correspondía a `004_pedidos_trazabilidad.sql`, no a `001`. Ya corregido arriba. Para que quede explícito: **001 y 004 no se solapan ni son redundantes** entre sí — son cambios independientes sobre la misma tabla (`pedidos`) pero columnas distintas:
- `001`: corrige el tipo de la columna `estado` (ENUM→VARCHAR) y repara filas que habían quedado con `estado=''` por ese bug.
- `004`: agrega las columnas `confirmado_at`/`preparacion_at`/`listo_at`/`entregado_at`, que `pedidos.py` y `reportes.py` usan activamente para trazabilidad y reportes de ventas.

No hay migración "autoritativa" a documentar porque ninguna de las dos reemplaza a la otra.
