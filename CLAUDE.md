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

- El backend requiere `backend/.env` (no versionado, sin plantilla `.env.example` en el repo). Variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SECRET_KEY`, `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `APP_NAME`, `DEBUG`, `MENU_URL`, `CORS_ORIGINS`, `CORS_ORIGIN_REGEX`, `COCINA_DEVICE_TOKEN`.
- `SECRET_KEY` ausente hace que `app/utils/security.py` lance `RuntimeError` al importar el módulo (falla rápido, intencional).
- `MENU_URL` se usa para generar las URLs embebidas en los QR y también se agrega automáticamente a los orígenes de CORS (`app/main.py`).
- Los tests no dependen del `.env` real: `tests/conftest.py` fuerza sus propias env vars (`SECRET_KEY`, `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`) con `setdefault` antes de importar la app.
- El esquema completo de la base de datos vive en `docs/database.sql`; los cambios incrementales están en `backend/migrations/*.sql` (se aplican manualmente, no hay ORM ni migration runner).

### Migraciones (`backend/migrations/`)

12 migraciones (`001` a `012`), secuenciales, sin runner (se corren a mano contra MySQL en desarrollo local; en Docker las aplica `backend/scripts/init_app.sh` automáticamente — ver sección Docker más abajo).

**001-006, verificado ejecutándolas de verdad** contra una base descartable (`scanorder_migration_test`, dropeada al terminar; `scanorder_db` no se tocó):

- **No aplican sobre una base de datos vacía (sin tablas).** Corrida directa de `001` → `006` sobre un schema en blanco: `001` falla en su primer statement —
  ```
  ALTER TABLE pedidos MODIFY COLUMN estado VARCHAR(20) NOT NULL DEFAULT 'pendiente';
  -- ERROR 1146 (42S02): Table 'scanorder_migration_test.pedidos' doesn't exist
  ```
  Las migraciones asumen un esquema base ya cargado (una versión *anterior* de la base, previa a estos fixes), no una DB en blanco.
- `docs/database.sql` ya es un snapshot consolidado que incluye el resultado final de `001`-`006` **y también de `008`**: `usuarios.rol` ya es `ENUM('admin','mozo')`, no `ENUM('admin','cocina')` (el commit que creó `008_roles_mozo.sql` tocó `docs/database.sql` a la vez). La línea de corte real es "001-006 + 008", no "001-006". **No** incluye el efecto de `007`, `009`, `010`, `011` ni `012` (tabla abajo) — para el schema real completo hay que cargar `docs/database.sql` y aplicar esas cinco a mano. Corriendo `001` → `006` **después** de cargar `docs/database.sql`, las 6 aplican sin error, pero **todas como no-ops** (cada `ALTER`/`UPDATE` afecta 0 filas) porque las columnas/tablas ya existen y no hay datos semilla.
- `002_menu_categorias_nuevas.sql` asume categorías ya existentes con IDs hardcodeados 1-4 (`UPDATE categorias ... WHERE id_categoria = 1`, etc.). Ni `docs/database.sql` ni ningún script del repo siembran esas filas — si esos IDs no existen, la migración no falla pero tampoco logra nada (0 filas afectadas, silencioso).
- `001` y `004` no son redundantes entre sí pese al nombre similar de "trazabilidad": `001` corrige el tipo de la columna `estado` (bug ENUM→VARCHAR que dejaba pedidos con `estado=''`); `004` agrega las columnas de fecha por estado (`confirmado_at`, `preparacion_at`, `listo_at`, `entregado_at`) que usan `pedidos.py` y `reportes.py`. Cambios independientes sobre la misma tabla, ninguno reemplaza al otro.

**007-012** — no reflejadas en `docs/database.sql` (salvo `008`, ver arriba); todas idempotentes, aplicadas automáticamente en orden por `init_app.sh` en Docker:

| # | Archivo | Qué hace |
|---|---|---|
| 007 | `007_must_change_password.sql` | Agrega `usuarios.must_change_password` (flag de cambio de contraseña obligatorio en el próximo login). |
| 008 | `008_roles_mozo.sql` | Migra `rol='cocina'` → `'mozo'` y cambia el `ENUM` de `usuarios.rol` a `('admin','mozo')`. Ya reflejada en `docs/database.sql`. |
| 009 | `009_fix_rol_vacio.sql` | Corrige usuarios que quedaron con `rol=''` tras la 008: tenían un rol inválido *antes* de esa migración, así que el `UPDATE ... WHERE rol='cocina'` de 008 no los alcanzó a tocar. |
| 010 | `010_inventory.sql` | Agrega `productos.stock_actual`/`stock_minimo` + `CHECK (stock_actual >= 0)` + tabla `movimientos_stock`. |
| 011 | `011_auth_complete.sql` | Crea tabla `password_reset_tokens` (recuperación de contraseña, un solo uso, TTL 30 min). |
| 012 | `012_drop_cierres_mesa_numero_mesa.sql` | Elimina `cierres_mesa.numero_mesa` — duplicaba `mesas.numero` (accesible vía `id_mesa`, que sí tiene FK) sin ningún uso real en el código: se escribía en el `INSERT` y nunca se volvía a leer en ningún lado (endpoints, reportes, tests, frontend). A diferencia de `precio_unitario` en `detalle_pedidos`, no protegía contra ninguna mutación real (no existe forma de renumerar una mesa) — violación de 3FN sin beneficio. Sin cambios de contrato de API. |

## Modelo de roles y autenticación (desde `refactor/roles-mozo`)

### Roles de usuario (`usuarios.rol`)

| Rol | ENUM | Accede a |
|---|---|---|
| `admin` | ✓ | Todo: gestión de mesas, productos, reportes, marcar estados, cerrar mesas |
| `mozo` | ✓ | Marcar estados de pedido (`PATCH /pedidos/{id}/estado`), cerrar mesas (`POST /mesas/{id}/cerrar`), atender mozo (`POST /mesas/{id}/atender-mozo`), ver pedidos activos |

El rol `cocina` fue eliminado del sistema de usuarios. Los usuarios existentes con `rol='cocina'` se migran a `mozo` con la migración `008_roles_mozo.sql`.

### Panel de cocina — autenticación por device_token

El panel de cocina (`frontend/cocina/pedidos.html`) ya **no requiere login de usuario**. Se protege con un token fijo por dispositivo:

- **Variable de entorno backend**: `COCINA_DEVICE_TOKEN` en `backend/.env`. Si está vacía, el WS rechaza todas las conexiones.
- **Variable frontend**: `window.COCINA_DEVICE_TOKEN` en el HTML de la página cocina (configurar por instalación, una vez, en `pedidos.html`).
- **WS `/pedidos/ws/cocina`**: valida `?device_token=<valor>` contra `COCINA_DEVICE_TOKEN`. Cierra con código `1008` si no coincide.
- **`GET /pedidos/activos-completos`**: acepta `?device_token=<valor>` como alternativa al JWT mozo/admin. Mismo token que el WS.
- El panel de cocina es **solo lectura** (muestra pedidos via WS/polling). Los mozos marcan estados desde su panel autenticado.

### `require_role` — uso variadic

```python
# Un solo rol (igual que antes)
Depends(require_role("admin"))

# Múltiples roles (cualquiera de los indicados pasa)
Depends(require_role("mozo", "admin"))
```

### Endpoints con permisos cambiados

| Endpoint | Antes | Ahora |
|---|---|---|
| `PATCH /pedidos/{id}/estado` | admin o cocina | admin o mozo |
| `GET /pedidos/activos-completos` | admin o cocina | admin, mozo, o device_token |
| `POST /mesas/{id}/cerrar` | admin | admin o mozo |
| `POST /mesas/{id}/atender-mozo` | admin | admin o mozo |
| `WS /pedidos/ws/cocina` | JWT (rol cocina o admin) | COCINA_DEVICE_TOKEN |

---

## Flujo de autenticación completo (`feature/auth-complete`)

### Creación de usuarios (solo admin)

El admin crea cuentas de mozos desde `/admin/usuarios`. No hay registro público. El sistema genera una contraseña temporal aleatoria (10 caracteres alfanuméricos), la guarda hasheada con `must_change_password=TRUE` y envía un email de bienvenida.

ABM completo (`feature/user-edit`): alta, baja lógica, modificación y consulta, los cuatro implementados.

| Endpoint | Método | Rol | Descripción |
|---|---|---|---|
| `GET /admin/usuarios` | GET | admin | Lista usuarios (sin password_hash). Campo `debe_cambiar_password` en respuesta. |
| `POST /admin/usuarios` | POST | admin | Crea usuario con contraseña temporal + envía email de bienvenida. |
| `PUT /admin/usuarios/{id}` | PUT | admin | Modifica `nombre`/`email`/`rol` (todos opcionales, solo actualiza los que vienen en el body). Valida email único (excluyendo al propio usuario) y rol contra `ROLES_VALIDOS`. No permite cambiar el password — eso tiene su propio flujo (`/auth/cambiar-password`, `/auth/reset-password`). |
| `PATCH /admin/usuarios/{id}/activo` | PATCH | admin | Alterna `activo`/`inactivo` (baja lógica, no hay DELETE físico). |
| `POST /admin/usuarios/{id}/reenviar-bienvenida` | POST | admin | Genera nueva contraseña temporal y reenvía email. |

### Recuperación de contraseña

| Endpoint | Método | Rol | Descripción |
|---|---|---|---|
| `POST /auth/forgot-password` | POST | Público | Genera token y envía email. Siempre devuelve 200. Rate limit: 3/email/hora (en memoria). |
| `POST /auth/reset-password` | POST | Público | Valida token, actualiza password, marca token como usado (no se borra). |

- Los tokens se guardan en `password_reset_tokens` (migración 011): 30 min de TTL, un solo uso.
- `forgot-password` **nunca confirma** si un email existe o no.

### Cambio de contraseña (autenticado)

`POST /auth/cambiar-password` — requiere `password_actual` + `nueva_password`. Valida la contraseña actual antes de actualizar. Limpia `must_change_password=FALSE`. Se usa también en el primer login forzado.

### Primer login forzado

`GET /auth/me` hace un DB lookup y devuelve `debe_cambiar_password` (reflejo de `must_change_password` en DB). El frontend redirige al formulario de cambio si es `true`. El backend **no bloquea** otros endpoints por este flag.

**Graceful degradation de `must_change_password`:** `GET /auth/me` y los cuatro endpoints de `/admin/usuarios` (`GET`, `POST`, `PUT`, `POST .../reenviar-bienvenida`) chequean si la columna existe antes de referenciarla (`usuarios_tiene_columna()`, una copia local en `auth.py` y otra en `admin.py` — mismo patrón cacheado con `_col_cache` que ya usan `producto_tiene_columna()`/`pedidos_tiene_columna()`/`mesa_tiene_columna()` en sus routers respectivos). Si la migración 007 no está aplicada, degradan a `debe_cambiar_password: False` (o insertan/actualizan sin esa columna) en vez de devolver 500 crudo — `POST /auth/login` ya hacía esto desde antes vía `.get("must_change_password", False)`.

### Email service (`app/services/email_service.py`)

Usa `smtplib` (stdlib, sin dependencias nuevas) contra un relay SMTP de un proveedor transaccional (no un Gmail personal: Google bloquea en silencio el envío automatizado hacia destinatarios sin historial previo con el remitente, sin generar rebote ni caer en spam). Variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, `FRONTEND_URL`. Si `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` no están configuradas, los envíos se descartan silenciosamente con un `WARNING` en los logs — el backend sigue funcionando.

Funciones públicas: `enviar_bienvenida(email, nombre, password_temporal)`, `enviar_reset_password(email, nombre, token)`.

**La contraseña temporal nunca se loguea.** El email falla silenciosamente para no bloquear la creación del usuario.

### Rate limit en `forgot-password`

Implementado con un dict en memoria (`_forgot_attempts`) en `routes/auth.py`. Ventana de 3600 segundos, máximo 3 intentos por email. Se resetea al reiniciar el proceso (aceptable para este caso de uso). No requiere dependencias externas (no usa slowapi).

**Rate limit de forgot-password:** implementado en memoria (diccionario Python).
Si el servidor se reinicia, el contador se resetea y un usuario podría
superar el límite de 3 intentos/hora entre reinicios.
Para producción: migrar a un contador persistente en DB o Redis.
Para el MVP académico: comportamiento aceptado y documentado.

### Páginas frontend del flujo de auth

| Archivo | Descripción |
|---|---|
| `frontend/login.html` | Login; redirige a `cambiar-password.html` si `debe_cambiar_password=true`; incluye link "¿Olvidaste tu contraseña?" |
| `frontend/cambiar-password.html` | Formulario con campo `password_actual` + `nueva_password` + confirmación. Subtitle dinámico según si es primer login. Redirect post-cambio: admin→`admin/index.html`, mozo→`admin/mesas.html`. |
| `frontend/forgot-password.html` | Formulario de email. Llama `POST /auth/forgot-password`. Siempre muestra "si el email existe recibirás un correo" (nunca confirma ni niega). Maneja 429 explícitamente. |
| `frontend/reset-password.html` | Lee `?token=` de la URL. Formulario nueva/confirmar. En 400 (token expirado/usado) muestra estado de error inline con link a forgot-password. |
| `frontend/admin/usuarios.html` | Panel admin: tabla con badge de estado (`Activo`/`Contraseña temporal`/`Inactivo`). Modal para crear usuario (nombre, email, rol) y modal separado para editar (mismos campos, precargados). Columna "Acciones" por fila con botones Editar / Reenviar bienvenida / Activar-Desactivar. Usa `requireAuth(ROLES.ADMIN)`. |

`fetchAPI(endpoint, method, body, auth=false)` — el 4to parámetro `false` omite el Bearer header para endpoints públicos (`forgot-password`, `reset-password`).

---

## Arquitectura backend (`backend/app/`)

- `main.py`: bootstrap de FastAPI, configuración de CORS (incluye auto-detección del origen desde `MENU_URL`) y registro de routers. No monta `/static` a propósito — los QR se sirven solo vía endpoint autenticado (`/mesas/{id}/qr`) para no exponer tokens embebidos en las imágenes.
- `database.py`: conexión directa con `mysql-connector-python` (sin ORM, sin pool gestionado por librería — cada función abre/cierra su propia conexión).
- `routes/`: un router por dominio (`auth`, `admin`, `productos`, `mesas`, `pedidos`, `reportes`, `inventario`). La autorización por rol usa la dependencia `require_role(...)` de `utils/dependencies.py` vía `Depends(...)` — **excepto** en `/auth/register`, `/pedidos/ws/cocina` (device_token) y el WS de mesa (qr_token manual).
- `utils/security.py`: hashing de passwords (bcrypt vía passlib) y JWT (encode/decode).
- `utils/dependencies.py`: `get_current_user` (valida Bearer JWT), `get_current_user_optional` (ídem pero devuelve None si no hay token), `require_role(*roles)` (variadic: acepta uno o varios roles).
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

El estado de `MesaSessionManager` (y el de `MesaOperationalState`, que vive en `mesas.py`) se mantiene en memoria de proceso pero se espeja a MySQL (tablas `mesa_sesiones_snapshot` / `mesa_estado_operativo`, migración `006_runtime_state.sql`) en cada mutación. Esa persistencia sí alimenta correctamente la vista agregada de `GET /mesas/mapa` (que lee directamente de DB para las mesas sin sesión viva en memoria).

**Limitación conocida — no se rehidrata la sesión viva al reconectar:** ni `MesaSessionManager.connect()` ni `MesaOperationalState.touch()` cargan el snapshot persistido al crear el estado en memoria — ambos parten de valores por defecto (`session.setdefault(...)` / `self.states.setdefault(...)`). Como el diccionario en memoria arranca vacío en cada arranque del proceso, esto significa que **tras un reinicio del backend, ni el carrito colaborativo de una mesa activa ni sus banderas `cuenta_solicitada`/`mozo_solicitado` se restauran automáticamente**: el primer `connect()`/`touch()` sobre esa mesa parte de los defaults y los vuelve a persistir, pisando lo que sí se había guardado antes del reinicio. El cliente debe rearmar el carrito a mano; una solicitud de mozo/cuenta pendiente puede perderse silenciosamente.

Acotado al caso de reinicio con mesas/sesiones activas — no afecta la operación normal (sin reinicios de por medio) ni ningún dato financiero: pedidos, cierres y stock se persisten y leen siempre desde DB, no dependen de este estado en memoria. Mejora futura: rehidratar `MesaSessionManager`/`MesaOperationalState` desde `load_session_snapshots()`/`load_operational_snapshot()` en `connect()`/`touch()` en vez de solo en la vista agregada.

Lo único que sí sigue siendo cierto sin matices: las conexiones WebSocket activas se pierden en cualquier reinicio del backend (los clientes deben reconectar).

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
- `pedidos_activos` (pendiente/confirmado/en_preparacion/listo) — solo los que siguen abiertos ahora
- `estado_pedidos_hoy` (pendiente/confirmado/en_preparacion/listo/entregado/cancelado) — desglose de **todos** los pedidos creados hoy, no solo los activos; distinto de `pedidos_activos`
- `producto_top` (`nombre`, `cantidad`)
- `categoria_top`
- `tiempo_prep_promedio_min`
- `mesa_top` (`numero`, `total`) — mesa con mayor facturación del día; `numero: null` si no hay ventas
- `mesas_activas` (COUNT DISTINCT de mesas con pedidos abiertos)
- `cobros_hoy` (total + desglose `metodos` desde `cierres_mesa`; defensivo: `{}` si la tabla no existe)

Endpoints hermanos, no incluidos en `/dashboard` pero consumidos por el mismo dashboard admin (`admin/js/index.js`):
- **`GET /reportes/ventas-hoy`** — serie de ventas por hora del día en curso (alimenta el gráfico de barras).
- **`GET /reportes/ventas-semana`** — serie de ventas de los últimos 7 días (alimenta el gráfico de tendencia semanal).

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

Todo en la misma conexión, con un único `connection.commit()` al final. Si cualquier paso falla, el `except` ejecuta `connection.rollback()` y devuelve 500 — la base queda exactamente como estaba antes del intento.

El `total_consumido` **siempre se recalcula en el backend** sumando `detalle_pedidos.subtotal`. El cliente no puede inyectar un total: `CierreMesaCreate` no tiene campo `total`.

**Cerrar mesa ya NO toca `pedidos.estado`** (desde `fix/cobro-sin-entrega`; ver "Cobro y entrega son ejes independientes" más abajo).

### Cleanup post-commit (best-effort, no en un try/except propio)

**Después** del `commit()`, el código intenta liberar la mesa en memoria (`mesas.py`, dentro de `cerrar_mesa`):
```python
mesa_sessions.force_release(int(mesa["numero"]))
mesa_operational_state.release(id_mesa)
```
Estas dos llamadas **no están envueltas en su propio `try/except`** — son statements planos dentro del `try:` general de la función, cubiertas únicamente por el `except HTTPException`/`except Exception` de más abajo, junto con todo el resto del cuerpo de `cerrar_mesa`.

Lo que sí contiene el escenario "falla algo del cleanup después de un commit exitoso" es una capa más abajo: `release_operational_state()` y `delete_session_snapshot()` (`repositories/mesa_state_repo.py`) — a las que `mesa_operational_state.release()`/`mesa_sessions.force_release()` delegan la escritura a DB — **sí** tienen su propio `try/except Exception` interno que traga errores de conexión/consulta sin relanzar. Entonces, en la práctica:

- Un fallo de **DB** durante el cleanup (tabla `mesa_estado_operativo`/`mesa_sesiones_snapshot` ausente, conexión caída) queda contenido ahí — nunca llega al `except` de `cerrar_mesa`, nunca dispara un `rollback()` sobre una transacción ya commiteada.
- Un fallo que **no sea de DB** (un bug de lógica en memoria dentro de `MesaOperationalState`/`MesaSessionManager`, que no tienen protección propia) sí se propagaría hasta el `except Exception` de `cerrar_mesa`: eso ejecuta `connection.rollback()` sobre una transacción que ya hizo `commit()` (no-op a nivel DB, InnoDB ya persistió) y devuelve 500 al mozo, aunque el cobro haya quedado registrado correctamente. Es un falso negativo de UX, no un riesgo financiero — el registro en `cierres_mesa`/`cierre_pedidos` ya existe, y la guarda anti-doble-cierre (más abajo) evita que un reintento cobre de nuevo.

**No "arreglar" esto reordenando el cleanup antes del commit.** Ejecutarlo antes liberaría la mesa antes de que el cierre quede persistido — sería peor que el falso negativo de UX actual.

### Cobro y entrega son ejes independientes (`fix/cobro-sin-entrega`)

Antes de esta rama, `cerrar_mesa` forzaba `estado='entregado'` sobre **todos** los pedidos incluidos en el cierre, sin importar si de verdad ya habían salido de cocina (`pendiente`/`confirmado`/`en_preparacion` quedaban marcados "entregados" igual). Como salvavidas, si algún pedido no estaba `listo`/`entregado` al momento del cobro, la mesa se dejaba `ocupada` en `mesa_operational_state` — pero el frontend (`GET /mesas/{id}/operacion`) no filtraba pedidos ya cobrados de su lista, así que el botón "Liberar mesa" nunca aparecía y la mesa quedaba trabada sin acción disponible (ni Cobrar, que devolvía 409, ni Liberar, que no se mostraba).

Diseño actual: **"cobrado" y "entregado" son estados independientes.**

- `cerrar_mesa` **no cambia `pedidos.estado` en absoluto**. Solo inserta en `cierres_mesa`/`cierre_pedidos` (eso es lo que define "cobrado": un pedido vinculado a una fila de `cierre_pedidos`). El pedido conserva su estado real de cocina.
- `cerrar_mesa` **siempre libera la mesa** (`mesa_operational_state.release` + `mesa_sessions.force_release`), tenga o no pedidos sin entregar. La ocupación del salón depende de si se cobró, no de si cocina terminó.
- El descuento de stock sigue ocurriendo **solo** en `PATCH /pedidos/{id}/estado` cuando `estado == "entregado"` (`descontar_stock_pedido`) — cobrar nunca lo dispara.
- El campo `entrega_pendiente` en la respuesta de `cerrar_mesa` es puramente informativo (había pedidos sin `listo`/`entregado` al momento del cobro); ya no condiciona si se libera la mesa.
- `GET /mesas/{id}/operacion` expone, por pedido, un flag `cobrado` (JOIN contra `cierre_pedidos`), y a nivel mesa dos booleanos calculados con el mismo criterio que usan `cerrar_mesa`/`liberar_mesa` (helpers `contar_pedidos_sin_cobrar`/`contar_pedidos_sin_entregar`, para que "puede cobrarse" y "puede liberarse" no se desincronicen):
  - `cobrada`: no queda ningún pedido del ciclo actual sin vincular a un cierre.
  - `tiene_pedidos_sin_entregar`: hay pedidos (cobrados o no) que todavía no llegaron a `entregado`.
- Frontend (`mesas.js`): el modal de mesa muestra **"Liberar mesa"** solo si `cobrada && ocupada`; en cualquier otro caso muestra **"Cobrar mesa"** — siempre hay una acción disponible, nunca un estado trabado.
- Pedidos cobrados pero no entregados siguen apareciendo con su estado real en el panel de cocina (`GET /pedidos/activos-completos`, WS `/pedidos/ws/cocina`) y en el modal de mesa, donde el mozo los entrega normalmente; ahí (y solo ahí) se descuenta stock.

Cubierto por `test_cobrar_mesa_con_pedido_en_preparacion_no_fuerza_entrega_y_libera_mesa`, `test_mesa_cobrada_se_puede_liberar_aunque_tenga_pedidos_sin_entregar` y `test_stock_no_se_descuenta_al_cobrar_solo_al_entregar_pedido_ya_cobrado` en `test_mesas_cierre.py`.

### Guarda anti-doble-cierre (independiente del estado operativo)

La guarda usa `SELECT ... FOR UPDATE` sobre los pedidos del **ciclo actual** de la mesa que todavía no están linkeados en `cierre_pedidos`. **No filtra por `estado = 'listo'`** — cualquier pedido no cancelado cuenta, consistente con "cobro y entrega son ejes independientes" (si filtrara por `listo`, no se podría cobrar una mesa con pedidos todavía `pendiente`/`confirmado`/`en_preparacion`, que es exactamente el caso que esta sección más arriba documenta como soportado):
```sql
SELECT p.id_pedido, p.estado, p.total
FROM pedidos p
LEFT JOIN cierre_pedidos cp ON cp.id_pedido = p.id_pedido
WHERE p.id_mesa = %s
  AND p.estado NOT IN ('cancelado')
  AND cp.id_pedido IS NULL
  AND p.created_at >= COALESCE(%s, CURDATE())
FOR UPDATE
```
El "ciclo actual" lo calcula `obtener_inicio_ciclo_mesa()` (arriba de `cerrar_mesa` en `mesas.py`): es el `created_at` del último `cierres_mesa` de esa mesa, o `CURDATE()` si nunca se cerró — así un pedido de un ciclo de cobro anterior nunca vuelve a entrar en juego en un cierre nuevo. La misma función y el mismo criterio los usa `contar_pedidos_sin_cobrar()`, para que "puede cobrarse" (este endpoint) y "puede liberarse" (`GET /mesas/{id}/operacion`) nunca queden desincronizados.

Si la primera transacción completó exitosamente, todos los pedidos del ciclo ya tienen fila en `cierre_pedidos` → la segunda consulta devuelve 0 filas → el endpoint devuelve 409.

**Esta guarda es infalible incluso si el cleanup falló** (mesa quede "ocupada" en caché). No depende de `mesa_estado_operativo` en absoluto. Verificado por `test_no_doble_cierre_aunque_mesa_no_se_libero_por_cleanup_fallido`.

### Validación del método de pago

El método de pago se valida contra una allow-list **antes de abrir conexión a la DB** (`mesas.py`, al inicio de `cerrar_mesa`). Un método inválido devuelve 400 inmediatamente, sin costo de conexión.

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

## Control de inventario (`feature/inventory-control`)

### Flujo completo

```
POST /pedidos/           →  validar_stock_batch()         # 409 si falta stock, NO descuenta
PATCH /pedidos/{id}/estado → body.estado == "entregado"   # descuenta stock (transacción única)
```

**Reglas de negocio:**
- Stock se valida y bloquea **antes** de crear el pedido. Si no hay stock → 409 con `productos_faltantes`.
- Stock se descuenta **solo al marcar "entregado"** (no al crear, no al confirmar, no al preparar).
- Cancelar un pedido **no modifica el stock** (nunca se descontó).
- Toda modificación de stock es transaccional. Si falla a mitad, rollback completo.

### `services/inventory_service.py`

| Función | Descripción |
|---|---|
| `validar_stock_batch(cursor, items)` | Lee stock en una sola query `IN()`. Lanza `InsufficientStockError` con lista completa de faltantes. Acepta cursor del caller (participante). |
| `descontar_stock_pedido(cursor, items, id_pedido, id_usuario)` | `SELECT ... FOR UPDATE` por ítem + `UPDATE productos SET stock_actual` + `INSERT movimientos_stock`. Acepta cursor del caller (participante). |
| `incrementar_stock(id_producto, cantidad, motivo, id_usuario)` | Gestiona su propia transacción. Tipo `entrada`. |
| `ajustar_stock_manual(id_producto, nuevo_stock, nuevo_minimo, motivo, id_usuario)` | Gestiona su propia transacción. Tipo `ajuste`. Calcula diferencia; si diferencia=0 no inserta movimiento. |
| `obtener_productos_bajo_minimo()` | Read-only, conexión propia. Retorna productos con `stock_actual < stock_minimo`. |

**Graceful degradation:** si `stock_actual` no existe en la tabla `productos` (migración 010 no aplicada), todas las funciones degradan en silencio sin error.

### `routes/inventario.py`

| Endpoint | Método | Requiere | Descripción |
|---|---|---|---|
| `GET /inventario/` | GET | admin | Lista todos con estado OK/BAJO/AGOTADO. Soporta `?estado=BAJO`. |
| `GET /inventario/bajo-minimo` | GET | admin | Solo productos con déficit. |
| `PUT /inventario/{id}` | PUT | admin | Ajuste manual de stock y mínimo. |
| `POST /inventario/{id}/entrada` | POST | admin | Entrada de stock (compra, reposición). |
| `GET /movimientos-stock/` | GET | admin | Historial paginado. Filtros: `producto_id`, `tipo`, `desde`, `hasta`, `page`, `limit`. |

### Atomicidad en entrega

En `PATCH /pedidos/{id}/estado` cuando `body.estado == "entregado"`:
1. `UPDATE pedidos SET estado = 'entregado', entregado_at = NOW()`
2. `SELECT id_producto, cantidad FROM detalle_pedidos WHERE id_pedido = %s`
3. Por cada ítem: `SELECT ... FOR UPDATE` → check no negativo → `UPDATE productos SET stock_actual` → `INSERT movimientos_stock`
4. **Un único `connection.commit()`** cubre todo.
5. Si cualquier paso falla: `connection.rollback()` en `except HTTPException` y `except Exception`. El pedido NO cambia de estado.

### `movimientos_stock` — convención de cantidades

- `tipo='salida'`: `cantidad` positivo (ej. 3 unidades entregadas).
- `tipo='entrada'`: `cantidad` positivo (ej. 5 unidades repuestas).
- `tipo='ajuste'`: `cantidad` con signo (positivo = aumento, negativo = reducción).
- Constraint `CHECK (cantidad != 0)` previene registros vacíos.

### UI Admin

`frontend/admin/inventario.html` + `frontend/admin/js/inventario.js`:
- Tabla con columnas: Producto, Categoría, Stock actual, Stock mínimo, Estado, Acciones.
- Badge de estado: `OK` (verde), `BAJO` (amarillo), `AGOTADO` (rojo).
- Banner de alerta global si hay productos con estado ≠ OK.
- Modal "Ajustar Stock" con campos `stock_actual`, `stock_minimo`, `motivo`.
- Polling automático cada 5 s (`setInterval(cargarInventario, 5000)`).

---

## Productos dados de baja: ver y reactivar desde admin

`DELETE /productos/{id}` es baja lógica (`disponible = FALSE`), pero `GET /productos/` por defecto solo devuelve `disponible = TRUE` (así lo necesita el menú público, que también pega contra este mismo endpoint). Sin distinción entre ambos casos, un producto dado de baja desaparecía también del panel admin, sin forma de verlo ni reactivarlo.

- **`GET /productos/?incluir_no_disponibles=true`** — el query param solo se honra si quien llama tiene un JWT válido de rol `admin` o `mozo` (`Depends(get_current_user_optional)`); sin token válido (o sin ese rol), se ignora en silencio y el comportamiento es idéntico al de siempre. El menú público (`frontend/cliente/menu.js`) nunca manda este parámetro, así que no cambia en nada.
- `frontend/admin/js/productos.js` (`cargarProductos()`) pide siempre este parámetro — por eso el stat card "No disponibles" de `productos.html` ahora refleja el número real, y la tabla muestra los productos de baja con badge "No disponible".
- **Reactivar** reusa el `PUT /productos/{id}` existente (no es un endpoint nuevo) mandando solo `{ "disponible": true }` — el `UPDATE` hace `COALESCE` campo por campo, así que el resto de los datos del producto queda intacto. En la fila de la tabla, el botón "Reactivar" (verde) reemplaza a "Eliminar" cuando el producto ya está de baja.

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
| `backend/scripts/init_app.sh` | Primer arranque: wait-for-MySQL, carga schema, aplica TODAS las migraciones incrementales posteriores a `docs/database.sql` (007→012, y las que se agreguen después), crea admin, lanza uvicorn. |
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
       ├─ load docs/database.sql (si usuarios no existe; consolida 001-006 y 008)
       ├─ apply migrations/*.sql con número ≥ 007, en orden (007, 008, 009,
       │  010, 011, 012, ...), cada una idempotente — se reintenta en cada
       │  restart del contenedor, así un volumen existente también se pone
       │  al día si la imagen trae migraciones nuevas
       ├─ create_admin.py → imprime password en logs
       └─ uvicorn app.main:app --host 0.0.0.0 --port 8000
  └─ web: nginx sirve /frontend/ en :80
```

**Antes de `fix/docker-migraciones`**, este paso solo aplicaba `007_must_change_password.sql`: `010_inventory.sql` (stock) y `011_auth_complete.sql` (`password_reset_tokens`) quedaban sin aplicar en una instalación limpia — el control de stock degradaba en silencio o daba 500 en las escrituras, y `POST /auth/forgot-password` devolvía 200 sin generar nunca un token. `init_app.sh` ahora recorre `migrations/*.sql`, salta `001`-`006` (ya consolidadas en `docs/database.sql`) y aplica el resto en orden; si alguna falla, aborta el arranque con un mensaje claro en vez de seguir de largo.

### Cambios en auth (`backend/app/routes/auth.py`)

- `POST /auth/login` ahora incluye `must_change_password: bool` en el payload de respuesta. Campo gracioso: usa `.get("must_change_password", False)` → devuelve `False` si la columna no existe (pre-migración 007). `GET /auth/me` y `/admin/usuarios` tienen el mismo tipo de guard hoy (ver "Graceful degradation de `must_change_password`" más arriba) — al principio solo `/login` lo tenía.
- `POST /auth/cambiar-password` (nuevo, requiere Bearer): valida 8-72 chars, `UPDATE usuarios SET password_hash, must_change_password=FALSE`.

### Cambio en frontend (`frontend/auth/js/login.js`)

Después de guardar el token: si `data.user.must_change_password` es `true`, redirige a `/frontend/cambiar-password.html` antes del redirect por rol.

### MENU_URL en Docker

`get_lan_ip()` (socket a 8.8.8.8) dentro del contenedor devuelve la IP de la red Docker, no la IP LAN del host. Solución: `MENU_URL` siempre explícita en `.env`. Documentado en `.env.example` con placeholder `TU_IP_LOCAL`. No usar `AUTO_LAN_IP` dentro de Docker.

### Puertos

- `:80` → nginx (frontend estático)
- `:8000` → uvicorn (API). `config.js` construye `API_URL` como `hostname:8000`, por eso FastAPI debe estar expuesto en ese puerto.

### Próxima migración

La última migración aplicada es `012_drop_cierres_mesa_numero_mesa.sql` (ver tabla completa de migraciones más arriba). La siguiente incremental será `013_*.sql`. `init_app.sh` la va a recoger automáticamente (recorre `migrations/*.sql` y aplica todo lo que no empiece con `001`-`006`) — **no hace falta tocar el script**, pero la migración nueva tiene que ser idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ADD CONSTRAINT IF NOT EXISTS`, `DROP COLUMN IF EXISTS`), porque se reaplica en cada arranque del contenedor.
