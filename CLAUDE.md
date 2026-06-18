# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

ScanOrder: sistema de gestión de pedidos por QR para un restaurante (Maven Burger). Backend FastAPI + MySQL, frontend HTML/CSS/JS vanilla sin build (sin bundler ni framework).

## Commands

Backend (desde `backend/`, con el venv activado):

```
pip install -r requirements.txt          # instalar dependencias
uvicorn app.main:app --reload             # levantar API en http://localhost:8000
pytest                                    # correr toda la suite
pytest tests/test_pedidos.py              # correr un archivo
pytest tests/test_pedidos.py::test_nombre -v   # correr un test puntual
```

No hay paso de build para el frontend: son archivos estáticos en `frontend/` que se sirven directo (ej. con Live Server en :5500) o desde cualquier servidor HTTP estático.

## Configuración / entorno

- El backend requiere `backend/.env` (no versionado, sin plantilla `.env.example` en el repo). Variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SECRET_KEY`, `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `APP_NAME`, `DEBUG`, `MENU_URL`, `CORS_ORIGINS`, `CORS_ORIGIN_REGEX`.
- `SECRET_KEY` ausente hace que `app/utils/security.py` lance `RuntimeError` al importar el módulo (falla rápido, intencional).
- `MENU_URL` se usa para generar las URLs embebidas en los QR y también se agrega automáticamente a los orígenes de CORS (`app/main.py`).
- Los tests no dependen del `.env` real: `tests/conftest.py` fuerza sus propias env vars (`SECRET_KEY`, `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`) con `setdefault` antes de importar la app.
- El esquema completo de la base de datos vive en `docs/database.sql`; los cambios incrementales están en `backend/migrations/*.sql` (se aplican manualmente, no hay ORM ni migration runner).

### Migraciones (`backend/migrations/`)

Orden de aplicación: `001` → `006`, secuencial, sin runner (se corren a mano contra MySQL).

**Verificado ejecutándolas de verdad** contra una base descartable (`scanorder_migration_test`, dropeada al terminar; `scanorder_db` no se tocó):

- **No aplican sobre una base de datos vacía (sin tablas).** Corrida directa de `001` → `006` sobre un schema en blanco: `001` falla en su primer statement —
  ```
  ALTER TABLE pedidos MODIFY COLUMN estado VARCHAR(20) NOT NULL DEFAULT 'pendiente';
  -- ERROR 1146 (42S02): Table 'scanorder_migration_test.pedidos' doesn't exist
  ```
  Las migraciones asumen un esquema base ya cargado (una versión *anterior* de la base, previa a estos fixes), no una DB en blanco.
- `docs/database.sql` ya es un snapshot consolidado que incluye el resultado final de las 6 migraciones (`estado` ya `VARCHAR(20)`, columnas `*_at` ya presentes, `cierres_mesa`/`cierre_pedidos`/`mesa_estado_operativo`/`mesa_sesiones_snapshot` ya creadas). Corriendo `001` → `006` **después** de cargar `docs/database.sql`, las 6 aplican sin error, pero **todas como no-ops** (cada `ALTER`/`UPDATE` afecta 0 filas) porque las columnas/tablas ya existen y no hay datos semilla.
- `002_menu_categorias_nuevas.sql` asume categorías ya existentes con IDs hardcodeados 1-4 (`UPDATE categorias ... WHERE id_categoria = 1`, etc.). Ni `docs/database.sql` ni ningún script del repo siembran esas filas — si esos IDs no existen, la migración no falla pero tampoco logra nada (0 filas afectadas, silencioso).
- `001` y `004` no son redundantes entre sí pese al nombre similar de "trazabilidad": `001` corrige el tipo de la columna `estado` (bug ENUM→VARCHAR que dejaba pedidos con `estado=''`); `004` agrega las columnas de fecha por estado (`confirmado_at`, `preparacion_at`, `listo_at`, `entregado_at`) que usan `pedidos.py` y `reportes.py`. Cambios independientes sobre la misma tabla, ninguno reemplaza al otro.

## Arquitectura backend (`backend/app/`)

- `main.py`: bootstrap de FastAPI, configuración de CORS (incluye auto-detección del origen desde `MENU_URL`) y registro de routers. No monta `/static` a propósito — los QR se sirven solo vía endpoint autenticado (`/mesas/{id}/qr`) para no exponer tokens embebidos en las imágenes.
- `database.py`: conexión directa con `mysql-connector-python` (sin ORM, sin pool gestionado por librería — cada función abre/cierra su propia conexión).
- `routes/`: un router por dominio (`auth`, `productos`, `mesas`, `pedidos`, `reportes`). La autorización por rol usa la dependencia `require_role("admin"|"cocina")` de `utils/dependencies.py` vía `Depends(...)` — **excepto** en `/auth/register` y en los dos endpoints WebSocket de `pedidos.py`, donde el rol/token se valida a mano leyendo headers o query params (inconsistencia de patrón conocida, no un bug).
- `utils/security.py`: hashing de passwords (bcrypt vía passlib) y JWT (encode/decode).
- `utils/dependencies.py`: `get_current_user` (valida Bearer JWT) y `require_role(rol)`.
- `utils/qr.py`: generación de PNG de QR con `qrcode[pil]`.

### Capas de servicio y repositorio (`services/`, `repositories/`)

Extraídas de `pedidos.py` en `refactor/layered-architecture`. No hay cambios de comportamiento.

```
repositories/mesa_state_repo.py   persist_operational_state / release_operational_state /
                                   load_operational_snapshot / persist_session_snapshot /
                                   delete_session_snapshot / load_session_snapshots
                                   (toda la SQL de snapshots, ~227 líneas)

services/cocina_manager.py        CocinaConnectionManager + singleton `manager`
                                   (broadcast WS a panel de cocina)

services/mesa_state.py            MesaOperationalState + singleton `mesa_operational_state`
                                   (estado ocupada/cuenta/mozo en memoria + espejo a DB)

services/mesa_sessions.py         MesaSessionManager + singleton `mesa_sessions`
                                   (carrito colaborativo, host/guest, persist/broadcast)
```

**Dependencias (sin ciclos):**
- `repositories/` ← solo `app.database` + stdlib
- `services/cocina_manager.py` ← solo FastAPI
- `services/mesa_state.py` ← `repositories/`
- `services/mesa_sessions.py` ← `repositories/` + `services/cocina_manager`
- `services/notifications.py` ← solo stdlib + twilio (opcional, lazy import)
- `routes/pedidos.py` ← `services/*` (ya no define las clases, solo las importa)
- `routes/mesas.py` ← `services/*` (ya no importa desde `routes/pedidos`)

**validate_qr_token():** helper en `pedidos.py` que centraliza la validación del token QR. Antes estaba copiada en `create_pedido`, `solicitar_servicio` y el handshake WS. Ahora es una sola función que lanza 403 si el token no coincide.

**`_calcular_estado_salon()`:** función pura en `mesas.py` (arriba de `mapa_mesas()`). Recibe datos de la mesa sin conexión a la DB y devuelve `(estado_salon, abandonada)`. Testeable sin MySQL.

### `pedidos.py` — el archivo más complejo (~1100 líneas)

Concentra tres responsabilidades distintas:
1. **CRUD de pedidos** (crear, listar, cambiar estado).
2. **WS `/pedidos/ws/cocina`**: push unidireccional de nuevos pedidos/cambios de estado al panel de cocina.
3. **WS `/pedidos/ws/mesa`**: carrito colaborativo host/guest por mesa, manejado por la clase `MesaSessionManager`. Soporta múltiples comensales editando el mismo carrito en tiempo real (acciones `sync_cart`/`clear_cart`, eventos `snapshot`/`carrito_actualizado`/`participantes_actualizados`/`pedido_confirmado`). Si el `host_client_id` se desconecta, el host se reasigna automáticamente a otro participante.

El estado de `MesaSessionManager` (y el de `MesaOperationalState`, que vive en `mesas.py`) se mantiene en memoria de proceso pero se espeja a MySQL (tablas `mesa_sesiones_snapshot` / `mesa_estado_operativo`, migración `006_runtime_state.sql`) en cada mutación, y se recarga al iniciar el proceso. Esto significa: **el contenido de negocio (carrito, participantes, estado operativo) sobrevive a un reinicio del backend**; lo único que se pierde son las conexiones WebSocket activas en sí (los clientes deben reconectar).

### Token de seguridad por mesa (`qr_token`)

Cada mesa tiene un `qr_token` (`secrets.token_urlsafe(24)`) embebido en la URL del QR. Es la única barrera contra que alguien adivine `?mesa=5` y haga pedidos o abra el WS de esa mesa sin haber escaneado el QR real. Se valida en `create_pedido`, `solicitar_servicio` y en el handshake de `/pedidos/ws/mesa`, y también forma parte de la `session_key` del carrito colaborativo (`f"{numero_mesa}:{qr_token or ''}"`) — por eso está acoplado con el carrito colaborativo, no solo con la validación de acceso. El chequeo de la columna es defensivo (`mesas_tiene_qr_token()`): si la columna no existe en la DB, el sistema sigue funcionando pero sin esa protección (degrada en silencio).

### "Mesa abandonada"

Es un cálculo derivado en cada `GET /mesas/mapa` (no hay timers/cron en background): una mesa se marca `abandonada` si tiene sesión activa, sin pedidos activos, carrito vacío y ≥10 min desde el escaneo del QR. Depende 100% del `MesaSessionManager` (feature anterior) para `session`, `items_carrito` y `minutos_desde_scan` — si se toca el carrito colaborativo, revisar este cálculo.

### Reportes CSV

Patrón común a todos los endpoints CSV: `io.StringIO` + `csv.writer`, respuesta `Response` con:
- BOM UTF-8 (`\xef\xbb\xbf`) para que Excel lo reconozca con encoding correcto.
- Separador `;` y línea `sep=;` como primera línea (convención Excel es-AR).
- `media_type="text/csv; charset=utf-8-sig"`.

**`GET /reportes/ventas?fecha_inicio=&fecha_fin=`** — reporte por rango de fechas (tres secciones: Resumen, Pedidos por estado, Productos top 10). `reportlab` fue eliminado.

**`GET /reportes/resumen-hoy?fecha=YYYY-MM-DD`** — resumen operativo de un día (por defecto hoy). Secciones: Resumen (ventas, pedidos, ticket, mesa top, producto top), Cobros por método de pago (solo si `cierres_mesa` existe), Pedidos por estado, Productos más vendidos, Ventas por hora (serie 0-23h). Disponible desde `feature/daily-dashboard`.

### Dashboard (`GET /reportes/dashboard`)

Devuelve JSON con métricas del día en curso. Campos:
- `ventas_hoy`, `pedidos_hoy`, `ticket_promedio`
- `pedidos_activos` (pendiente/confirmado/en_preparacion/listo)
- `producto_top` (`nombre`, `cantidad`)
- `mesa_top` (`numero`, `total`) — mesa con mayor facturación del día; `numero: null` si no hay ventas
- `mesas_activas` (COUNT DISTINCT de mesas con pedidos abiertos)
- `cobros_hoy` (total + desglose `metodos` desde `cierres_mesa`; defensivo: `{}` si la tabla no existe)

## Arquitectura frontend (`frontend/`)

Estático, sin build ni framework, organizado por área/rol:
- `admin/` — panel de administración (mesas, productos, dashboard).
- `cliente/` — menú público que el cliente ve al escanear el QR de su mesa (`menu.html`/`menu.js`, incluye la lógica del WS de carrito colaborativo).
- `cocina/` — panel de pedidos para cocina (consume el WS `/pedidos/ws/cocina`).
- `auth/` y `home/` — login y landing.
- `assets/js/`: utilidades compartidas entre todas las áreas — `config.js` (URLs, rutas, roles, intervalo de polling), `api.js` (cliente HTTP genérico: agrega `Authorization: Bearer`, espera errores como `{ "detail": "..." }`, fuerza logout en 401), `auth.js`.

`API_URL` se resuelve dinámicamente en `config.js` a partir de `window.location` (o `window.SCANORDER_API_URL` si está definida), no está hardcodeada — esto permite que el mismo frontend funcione tanto en `localhost` como accedido desde otro dispositivo en la LAN (necesario porque los QR apuntan a una IP de LAN vía `MENU_URL`).

## Comportamiento verificado: `POST /mesas/{id}/cerrar`

Auditado y cubierto con tests de integración contra MySQL real (`backend/tests/test_mesas_cierre.py`).

### Atomicidad financiera (garantía InnoDB)

El bloque financiero del cierre es una **única transacción InnoDB**:
1. `INSERT INTO cierres_mesa` (registro del cierre con total recalculado)
2. `INSERT INTO cierre_pedidos` × N (uno por pedido incluido)
3. `UPDATE pedidos SET estado = 'entregado'` × N

Todo en la misma conexión, con un único `connection.commit()` al final. Si cualquier paso falla, el `except` ejecuta `connection.rollback()` y devuelve 500 — la base queda exactamente como estaba antes del intento.

El `total_consumido` **siempre se recalcula en el backend** sumando `detalle_pedidos.subtotal`. El cliente no puede inyectar un total: `CierreMesaCreate` no tiene campo `total`.

### Cleanup post-commit (best-effort, por diseño)

**Después** del `commit()`, el código intenta liberar la mesa en memoria:
```python
mesa_operational_state.release(id_mesa)   # línea ~662
mesa_sessions.force_release(numero)       # línea ~663
```
Ambas llamadas están en bloques `try/except` que **tragan todas las excepciones sin re-lanzar**. Esto es **intencional y correcto**:

- El cleanup solo puede fallar *después* de un commit exitoso. Nunca puede dejar la base a medias.
- La dirección de fallo es segura: si falla el cleanup, la mesa queda "ocupada" en caché pero el registro financiero ya existe y es íntegro.
- La dirección opuesta sería peligrosa: ejecutar el cleanup *antes* del commit podría liberar la mesa antes de que el cierre quede persistido.

**No "arreglar" esto reordenando el cleanup antes del commit.** Ese cambio introduciría una ventana de corrupción.

### Guarda anti-doble-cierre (independiente del estado operativo)

La guarda usa `SELECT ... FOR UPDATE` buscando pedidos **no linkeados en `cierre_pedidos`**:
```sql
SELECT p.* FROM pedidos p
LEFT JOIN cierre_pedidos cp ON cp.id_pedido = p.id_pedido
WHERE p.id_mesa = %s AND cp.id_pedido IS NULL
AND p.estado = 'listo'
FOR UPDATE
```
Si la primera transacción completó exitosamente, todos los pedidos ya tienen fila en `cierre_pedidos` → la segunda consulta devuelve 0 filas → el endpoint devuelve 409.

**Esta guarda es infalible incluso si el cleanup falló** (mesa quede "ocupada" en caché). No depende de `mesa_estado_operativo` en absoluto. Verificado por `test_no_doble_cierre_aunque_mesa_no_se_libero_por_cleanup_fallido`.

### Validación del método de pago

El método de pago se valida contra una allow-list **antes de abrir conexión a la DB** (líneas ~525-530). Un método inválido devuelve 400 inmediatamente, sin costo de conexión.

---

## Notificaciones externas (`services/notifications.py`)

Interfaz `NotificationService` con un único método:
```python
def notify(self, evento: dict) -> None: ...
```

`evento` siempre incluye `"type"` (`"pedido_creado"` | `"servicio_mesa"`) y `"numero_mesa"`.

### Implementaciones

| Clase | Estado | Activación |
|---|---|---|
| `TwilioWhatsAppNotifier` | Activa | Las 4 vars `TWILIO_*` presentes en `.env` |
| `EscPosPrinterNotifier` | Stub (TODO) | Ver docstring en el archivo |
| `_NullNotifier` | Fallback | Vars ausentes o Twilio no instalado |

El singleton `notification_service` se construye al importar el módulo (`_build_notifier()`). Si Twilio no está configurado o falla la inicialización, devuelve silenciosamente `_NullNotifier` — el backend arranca igual.

### Puntos de disparo

Ambos en `routes/pedidos.py`, **post-commit**, en bloques `try/except` independientes:
- `create_pedido` → `notify({"type": "pedido_creado", "numero_mesa": ..., "total": ..., "id_pedido": ...})`
- `solicitar_servicio` → `notify({"type": "servicio_mesa", "tipo": "mozo"|"cuenta", "numero_mesa": ...})`

Un fallo de notificación se loguea como `WARNING` y nunca se propaga al cliente.

### Cómo agregar la impresora térmica (ESC/POS)

1. Implementar `EscPosPrinterNotifier.notify()` (clase ya existe en el archivo, con TODO detallado).
2. Elegir librería (`python-escpos` o similar) y agregarla a `requirements.txt`.
3. En `_build_notifier()`, agregar rama que lea `PRINTER_TARGET` del env e instancie `EscPosPrinterNotifier`.
4. Si se quieren notificaciones en paralelo (WhatsApp + impresora), envolver ambas en un `CompositeNotifier` que itere una lista de `NotificationService`.

---

## Notas para cambios futuros

- Si se elimina o modifica el carrito colaborativo (`MesaSessionManager`), revisar en cascada: detección de "mesa abandonada" (depende de él), `qr_token`/`session_key` (se cruza con él), y los consumidores frontend `frontend/cliente/menu.js` y `frontend/admin/js/mesas.js`.
- Hay tres llamadas independientes a `load_dotenv()` (`main.py`, `database.py`, `security.py`) — es idempotente y no rompe nada, pero indica que no hay un único punto de carga de configuración.
- Un análisis más detallado de endpoints, riesgos de eliminar cada feature y discrepancias con la documentación de producto está en [AUDITORIA.md](AUDITORIA.md).

---

## Setup Docker (`chore/dockerized-setup`)

### Archivos creados

| Archivo | Descripción |
|---|---|
| `Dockerfile` | Imagen Python 3.12-slim + mysql-client. ENTRYPOINT = `init_app.sh`, CMD = uvicorn. |
| `docker-compose.yml` | 3 servicios: `db` (mysql:8.0), `app` (backend), `web` (nginx:1.27-alpine). |
| `nginx.conf` | Root = repo root; sirve `/frontend/`; bloquea `/backend/` y `/docs/`. |
| `.env.example` | Plantilla versionada. `.env` y `.env.docker` están en `.gitignore`. |
| `backend/scripts/init_app.sh` | Primer arranque: wait-for-MySQL, carga schema, aplica migración 007, crea admin, lanza uvicorn. |
| `backend/scripts/create_admin.py` | Si `usuarios` vacía: genera password aleatorio, inserta admin con `must_change_password=TRUE`, imprime credenciales. |
| `backend/migrations/007_must_change_password.sql` | `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE` (idempotente). |
| `frontend/cambiar-password.html` | Página de cambio de contraseña en primer login. Valida largo, llama `POST /auth/cambiar-password`, redirige según rol. |
| `INSTALL.md` | Guía paso a paso para no-técnicos (10 pasos). |

### Flujo de primer arranque

```
docker compose up
  └─ db: MySQL ready (healthcheck)
  └─ app: init_app.sh
       ├─ wait MySQL
       ├─ load docs/database.sql (si usuarios no existe)
       ├─ apply 007_must_change_password.sql (idempotente)
       ├─ create_admin.py → imprime password en logs
       └─ uvicorn app.main:app --host 0.0.0.0 --port 8000
  └─ web: nginx sirve /frontend/ en :80
```

### Cambios en auth (`backend/app/routes/auth.py`)

- `POST /auth/login` ahora incluye `must_change_password: bool` en el payload de respuesta. Campo gracioso: usa `.get("must_change_password", False)` → devuelve `False` si la columna no existe (pre-migración 007).
- `POST /auth/cambiar-password` (nuevo, requiere Bearer): valida 8-72 chars, `UPDATE usuarios SET password_hash, must_change_password=FALSE`.

### Cambio en frontend (`frontend/auth/js/login.js`)

Después de guardar el token: si `data.user.must_change_password` es `true`, redirige a `/frontend/cambiar-password.html` antes del redirect por rol.

### MENU_URL en Docker

`get_lan_ip()` (socket a 8.8.8.8) dentro del contenedor devuelve la IP de la red Docker, no la IP LAN del host. Solución: `MENU_URL` siempre explícita en `.env`. Documentado en `.env.example` con placeholder `TU_IP_LOCAL`. No usar `AUTO_LAN_IP` dentro de Docker.

### Puertos

- `:80` → nginx (frontend estático)
- `:8000` → uvicorn (API). `config.js` construye `API_URL` como `hostname:8000`, por eso FastAPI debe estar expuesto en ese puerto.

### Próxima migración

La siguiente migración incremental será `008_*.sql`.
