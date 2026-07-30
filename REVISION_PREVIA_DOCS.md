# Revisión previa a documentación final — ScanOrder

**Fecha de la revisión:** 2026-07-29
**Alcance:** solo lectura. No se modificó código fuente ni configuración.
**Rama revisada:** `origin/dev` @ `ed419eb` (2026-07-27). Nota: el `dev` local estaba 3 commits atrás de `origin/dev`; se revisó el remoto por ser la versión más actual y compartida de la rama.
**Método:** corrida real de la suite de tests contra MySQL local, más lectura de código (backend completo, frontend completo, schema + migraciones) por 5 procesos de auditoría independientes.

---

## 1. Tests

**176 / 176 tests pasan.** 0 fallos, 0 skips, ~22 s de ejecución.

```
176 passed, 150 warnings in 22.46s
```

Corridos contra una instancia MySQL real en `localhost:3306` (no mockeada) — confirmado verificando que el puerto estaba escuchando y que `tests/conftest.py` solo fuerza `SECRET_KEY`/`ALGORITHM`/`ACCESS_TOKEN_EXPIRE_MINUTES`, sin mockear la capa de DB. Los tests de `test_mesas_cierre.py` (atomicidad del cierre) son de integración real, tal como documenta CLAUDE.md.

| Archivo | Tests |
|---|---|
| `test_auth_complete.py` | 26 |
| `test_reportes_dashboard.py` | 24 |
| `test_roles_mozo.py` | 22 |
| `test_mesa_sessions.py` | 21 |
| `test_inventory.py` | 20 |
| `test_mesas_estado_salon.py` | 19 |
| `test_caract_pedidos.py` | 17 |
| `test_notifications.py` | 13 |
| `test_mesas_cierre.py` | 7 |
| `test_productos.py` | 4 |
| `test_pedidos.py` | 3 |
| **Total** | **176** |

Warnings (no bloqueantes, no requieren acción para la entrega): deprecación de `httpx` `app=` shortcut, deprecación de `python_multipart`, y `InsecureKeyLengthWarning` de PyJWT porque el `SECRET_KEY` de test tiene 15 bytes (el de test, no el de producción — no es un hallazgo real, es config de `conftest.py`).

**Conclusión: la suite es sólida y confiable como red de seguridad para la documentación final.**

---

## 2. Integridad de features end-to-end

Leyenda: ✅ funciona sin problemas · ⚠️ funciona pero con un gap o deuda técnica real · ❌ roto

| # | Feature | Estado |
|---|---|---|
| 1 | Login + roles (admin, mozo) | ✅ |
| 2 | ABM de usuarios | ✅ (bulk actions son client-side, no atómicas) |
| 3 | Recuperación de contraseña | ⚠️ link roto en email de bienvenida |
| 4 | CRUD de productos | ⚠️ soft-delete sin forma de ver/reactivar |
| 5 | Flujo de pedido (crear→cocina→entregar→cobrar) | ⚠️ dos estados inalcanzables desde la UI |
| 6 | Control de stock | ✅ core sólido / ⚠️ 2 endpoints sin UI |
| 7 | Cierre de mesa | ✅ (coincide con lo documentado, 1 matiz menor) |
| 8 | Reportes + export CSV | ✅ |
| 9 | WebSockets (cocina + carrito colaborativo) | ⚠️ 3 bugs concretos |

### 2.1 Login + roles — ✅

`POST /auth/login` (`backend/app/routes/auth.py:118-176`) genera el JWT con `{user_id, email, rol}`, `require_role` (`utils/dependencies.py:9-75`) filtra correctamente en todos los routers, y el rol `cocina` no tiene ningún rastro de flujo de login roto (el panel de cocina usa `device_token`, como corresponde). `must_change_password` fuerza el cambio en primer login vía `frontend/auth/js/login.js` + `assets/js/auth.js`.

Hallazgo cosmético: el docstring de `PATCH /pedidos/{id}/estado` (`pedidos.py:656`) dice "admin o cocina" pero el código real valida `{"admin","mozo"}` — comentario desactualizado, sin impacto funcional.

### 2.2 ABM de usuarios — ✅

Los 5 endpoints (`GET/POST /admin/usuarios`, `PUT /admin/usuarios/{id}`, `PATCH .../activo`, `POST .../reenviar-bienvenida`) están completos y el rediseño reciente de `usuarios.html`/`usuarios.js` (commit `ed419eb`) sigue llamándolos con los payloads correctos — no hay ningún ID de DOM ni endpoint roto.

Las **acciones masivas** agregadas en el último commit (cambiar rol / desactivar en lote) **no son un endpoint bulk real**: `usuarios.js:314-369` itera `Promise.all()` sobre los endpoints unitarios existentes. Funciona, pero no es atómico — si una llamada falla a mitad de un lote, las anteriores ya se aplicaron sin rollback conjunto. Deuda técnica aceptable para el alcance actual, no un bug.

Hallazgos menores: la columna "Último acceso" en la tabla de usuarios (`usuarios.js:219-224`) lee campos (`ultimo_acceso`/`last_login`) que el backend nunca envía — nunca muestra un dato real (degrada con gracia, pero es una columna sin contenido útil). Variable muerta en `toggleActivo` (`usuarios.js:518-519`).

### 2.3 Recuperación de contraseña — ⚠️ bug real de una línea

Flujo completo correcto: rate limit 3/hora en memoria, token de un solo uso con TTL 30 min en `password_reset_tokens` (schema coincide exactamente con lo que usa `auth.py`), frontend maneja los 3 estados de error (token inválido/expirado/usado, 429).

**Bug:** `backend/app/services/email_service.py:71` — el link del **email de bienvenida** apunta a `{FRONTEND_URL}/frontend/auth/login.html`, que **no existe** (el login real es `/frontend/login.html`; `frontend/auth/` solo contiene CSS/JS de esa página, no el HTML). Cualquier usuario nuevo que haga clic en el link del mail de bienvenida cae en un 404. El email de reset de contraseña sí usa la ruta correcta. **Fix de una línea**, recomendado antes de la entrega.

### 2.4 CRUD de productos — ⚠️

Create/Update/Delete están bien implementados y el payload de `productos.js` coincide con los schemas Pydantic.

**Gap:** `GET /productos/` (`productos.py:112`) siempre filtra `WHERE disponible = TRUE`, y es el único endpoint de listado — lo usan tanto el menú público como el panel admin. Como el "delete" es soft-delete (`disponible = FALSE`), **un producto dado de baja desaparece también de la vista del admin**, sin forma de verlo ni reactivarlo desde la UI. El stat card "No disponibles" en `productos.html` siempre muestra 0 por el mismo motivo (nunca llegan datos de productos no disponibles al navegador).

### 2.5 Flujo de pedido — ⚠️

Los estados backend (`pendiente→confirmado→en_preparacion→listo→entregado`) y el panel de cocina (correctamente solo-lectura, sin ningún PATCH) están bien implementados.

**Gap:** la única superficie de UI que dispara `PATCH /pedidos/{id}/estado` es `mesas.js:428-437`, y solo cablea **2 de las 4 transiciones**: pendiente→confirmado, y →entregado (directo, para mozo). **No existe ningún botón para confirmado→en_preparacion ni en_preparacion→listo.** El backend ya calcula `siguiente_estado` en `GET /mesas/{id}/operacion` (`mesas.py:442-447`) pensado exactamente para resolver esto, pero el frontend nunca lo lee. En la práctica, esos dos estados intermedios quedan vivos en el modelo de datos y en reportes, pero son inalcanzables desde la UI actual — vale la pena decidir si es una funcionalidad pendiente o un diseño intencional (mozo marca directo "entregado") antes de documentarlo como flujo completo.

### 2.6 Control de stock — ✅ / ⚠️

El flujo central (`validar_stock_batch` al crear, `descontar_stock_pedido` al entregar, transacción única) está correctamente implementado y probado.

Gaps menores: `POST /inventario/{id}/entrada` y `GET /movimientos-stock/` no tienen ningún consumidor en el frontend — el admin solo puede "ajustar" stock absoluto, no registrar entradas discretas ni ver el historial, pese a que el backend ya lo soporta. Además, `incrementar_stock()`/`ajustar_stock_manual()` (los que respaldan `PUT /inventario/{id}` y `POST .../entrada`) **no** chequean si la migración 010 está aplicada — a diferencia de `GET /inventario/`, que sí degrada con un 503 claro, estos dos devolverían un 500 crudo si faltara la columna `stock_actual`. Riesgo bajo (010 se aplica siempre en Docker), pero inconsistente con lo que CLAUDE.md afirma ("todas las funciones degradan en silencio").

### 2.7 Cierre de mesa — ✅

Confirmado que el código actual coincide con la descripción detallada de CLAUDE.md: transacción atómica InnoDB, `cerrar_mesa` no toca `pedidos.estado`, siempre libera la mesa, guarda anti-doble-cierre con `SELECT...FOR UPDATE`, validación de método de pago antes de abrir conexión. El frontend replica exactamente la regla `cobrada && ocupada` para mostrar "Liberar" vs "Cobrar".

Matiz: las dos llamadas de cleanup post-commit (`mesas.py:742-743`) ya no están en un bloque `try/except` propio y directo como describe CLAUDE.md — están dentro del `try` general de la función, protegidas indirectamente porque la capa de repositorio (`mesa_state_repo.py`) atrapa sus propios errores de DB. Si alguna lanzara una excepción no relacionada con DB, el `except` externo haría `rollback()` sobre una transacción ya commiteada y devolvería 500 al mozo aunque el cobro ya quedó guardado (falso negativo de UX, sin riesgo financiero real gracias al guard anti-doble-cierre).

### 2.8 Reportes + export CSV — ✅

Todos los campos que consume el dashport (`admin/js/index.js`) existen tal cual en las respuestas de `reportes.py`, incluyendo el endpoint de tendencia semanal agregado recientemente (`GET /reportes/ventas-semana` ↔ `cargarVentasSemana()`). Sin hallazgos.

### 2.9 WebSockets — ⚠️ 3 bugs concretos

- **Panel de mesas del admin nunca abre su WS de tiempo real**: `mesas.js:877` exige `window.COCINA_DEVICE_TOKEN`, variable que solo se define en `cocina/pedidos.html` — nunca en `admin/mesas.html`. La UI sigue funcionando por el polling de respaldo (cada 2.5s), pero se pierde el push instantáneo de nuevos pedidos.
- **Dashboard admin usa el parámetro equivocado**: `index.js:90` abre el WS de cocina con `?token=<jwt>` en vez de `?device_token=<valor>`. El backend cierra con 1008 en cada intento (`pedidos.py:129-131`); reintenta cada 4s indefinidamente sin éxito, y no hay polling de respaldo para el dashboard — solo se actualiza al recargar la página a mano.
- **Carrito colaborativo sin reconexión**: a diferencia de cocina y mesas, `menu.js:1232-1235` no reintenta conectar tras un `close` del WS — el cliente queda "Sin conexión" hasta recargar. El envío de pedidos sigue funcionando por HTTP directo, así que no bloquea la operación, solo la sincronización multi-dispositivo del carrito.
- **La resiliencia a reinicio del backend es parcial, contradice un punto de CLAUDE.md**: `MesaSessionManager.connect()` (`services/mesa_sessions.py:80-100`) nunca llama a `load_session_snapshots()` para rehidratar la sesión viva desde `mesa_sesiones_snapshot`. Tras un reinicio, un cliente que reconecta recibe un carrito vacío aunque la fila en DB tenga el contenido real (el snapshot solo se usa para la vista agregada de `GET /mesas/mapa`, no para restaurar la sesión). Esto contradice la afirmación de CLAUDE.md de que "el contenido de negocio... sobrevive a un reinicio del backend" — vale la pena corregir la documentación o el código antes de la entrega.

---

## 3. Consistencia

### 3.1 `docs/database.sql` + migraciones vs código real

- **12 tablas reales** tras aplicar todas las migraciones (ver inventario completo en §5.3). `docs/database.sql` solo contiene 10 — le faltan `movimientos_stock` y `password_reset_tokens` (de las migraciones 010 y 011), y la columna `usuarios.must_change_password` (migración 007).
- **Imprecisión en CLAUDE.md**: afirma que `docs/database.sql` "consolida 001-006", pero en realidad ya incorpora el efecto de la migración **008** también (`usuarios.rol` ya es `ENUM('admin','mozo')` en el schema base, no `ENUM('admin','cocina')`). Es decir, la línea de corte real es "001-006 + 008", no "001-006". Consecuencia práctica: ninguna — 008 es idempotente — pero conviene corregir la afirmación en la doc técnica final.
- `backend/scripts/init_app.sh` aplica correctamente todas las migraciones ≥007 encontradas en el directorio (007-011), en orden, todas idempotentes. No hay migraciones 012+ sin contemplar.
- Todas las tablas que el código consulta existen en el schema/migraciones — no se encontró ninguna tabla fantasma.
- Columnas dependientes de migración con **graceful degradation incompleta** (ver detalle en §2.6 y más abajo): `incrementar_stock`/`ajustar_stock_manual` (inventario), y los endpoints `GET /auth/me`, `GET/POST/PUT /admin/usuarios` que referencian `must_change_password` sin chequear si la columna existe (riesgo bajo en la práctica, pero real).

### 3.2 Endpoints frontend ↔ backend

**No se encontró ningún endpoint que el frontend llame y no exista en el backend** — se cruzaron las 48 rutas del inventario de endpoints (§5.2) contra las ~35 llamadas distintas detectadas en todo `frontend/**/*.js` y no hay ningún mismatch.

Endpoints del backend **sin ningún consumidor en el frontend** (no rotos, simplemente no usados desde la UI actual):
- `POST /auth/register` — el flujo real de alta de usuarios es `/admin/usuarios`; este endpoint parece vestigial de una versión anterior sin registro público.
- `GET /auth/admin-only` — endpoint de diagnóstico, solo referenciado desde tests.
- `GET /inventario/bajo-minimo`, `POST /inventario/{id}/entrada`, `GET /movimientos-stock/` — funcionalidad de backend sin UI (ver §2.6).

### 3.3 Código muerto / TODOs / imports huérfanos

- **TODOs**: solo en `services/notifications.py` (stub de impresora ESC/POS), intencional y ya documentado en CLAUDE.md. No hay `FIXME`/`XXX`/`HACK` reales en el resto del código.
- **Import muerto**: `List` sin usar en `backend/app/routes/inventario.py:4`.
- **Clase muerta**: `UserResponse` en `backend/app/schemas/auth.py:39`, definida pero nunca usada como `response_model` ni importada en ningún lado.
- **Campo huérfano**: `PedidoCreate.client_id` (`schemas/pedidos.py:18`) se acepta en el body de `POST /pedidos/` pero el backend nunca lo lee — probablemente resto de una integración con el `client_id` del carrito WS que no se completó.
- **Duplicación de reglas de negocio**: `ROLES_VALIDOS = {"admin","mozo"}` está definido igual e independiente en `admin.py` y `schemas/auth.py` — si se agrega un rol hay que recordar tocar los dos lugares. La lógica de "pedidos sin cobrar" está escrita 3 veces por separado en `mesas.py` (función helper + 2 queries inline) — es la causa raíz del riesgo que el propio CLAUDE.md señala sobre que "cobrable"/"liberable" podrían desincronizarse. `reportes.py` repite el mismo patrón de "top producto/mesa + serie por hora" en 4 endpoints distintos sin un helper compartido.
- **Inconsistencia de patrón** (no bug): `PATCH /pedidos/{id}/estado` valida el rol a mano (`if rol not in {...}: raise 403`) en vez de usar `Depends(require_role(...))` como el resto de los endpoints equivalentes.

---

## 4. Lo que un evaluador podría señalar

Priorizado de mayor a menor impacto:

1. **Link roto en email de bienvenida** (`email_service.py:71`) — un usuario nuevo no puede llegar al login desde el mail que recibe. Bug de una línea, fácil de arreglar antes de entregar.
2. **Dashboard admin sin tiempo real** (WS con parámetro equivocado) y **panel de mesas sin push instantáneo** (variable global no definida) — ambos degradan a polling, funcionan, pero no son lo que la arquitectura documentada promete.
3. **Afirmación de CLAUDE.md sobre persistencia del carrito tras reinicio no se cumple del todo** — el snapshot en DB existe pero no se usa para rehidratar la sesión viva al reconectar. Si un evaluador reinicia el backend en medio de una demo con un carrito cargado, lo va a notar.
4. **Productos dados de baja son irrecuperables desde la UI** — probablemente no es el comportamiento esperado de un ABM completo si "baja lógica" implica poder reactivar.
5. **`en_preparacion`/`listo` inalcanzables desde la UI** — si la consigna académica pide un flujo de cocina con más de 2 pasos visibles, esto puede leerse como incompleto aunque el modelo de datos lo soporte.
6. **3FN**: el diseño está limpio en general (buen ejemplo: `cierre_pedidos` con `UNIQUE(id_pedido)` modelando la regla de negocio "no se cobra dos veces"; `precio_unitario` capturado en el momento del pedido, no referenciado en vivo). Hay **una violación real y localizada**: `cierres_mesa.numero_mesa` es dependencia transitiva de `id_mesa` (vía `mesas.numero`), porque `id_mesa` no es clave candidata en `cierres_mesa` (una mesa tiene múltiples cierres). Es defendible como denormalización intencional (preserva el número de mesa al momento del cierre), pero conviene mencionarlo explícitamente en la carpeta técnica en vez de que lo encuentre el evaluador.
7. **`mesas.estado` es una columna muerta** (nunca se actualiza después del `INSERT`, no se expone en la API) — si se arma un diagrama ER a partir del `CREATE TABLE` literal, conviene marcarla como legacy para no sugerir que es la fuente de verdad de la ocupación (esa es `mesa_estado_operativo.ocupada`).
8. **Documentación desactualizada** (bajo impacto pero rápido de corregir): CLAUDE.md dice que `docs/database.sql` consolida "001-006" (en realidad también 008); dice que el polling de inventario es cada 30s (el código hace 5s); describe el cleanup post-cierre con try/except propio que ya no está exactamente así en el código.
9. **ABM de usuarios**: el requisito académico de ABM está completo (alta/baja/modificación/consulta, los 4 verificados end-to-end). Las "acciones masivas" son cosméticas sobre los mismos endpoints unitarios — no hay nada roto, pero tampoco son atómicas si eso se llegara a preguntar.

Ningún hallazgo de esta lista implica pérdida de datos, brecha de seguridad, ni inconsistencia financiera — el bloque de cobro/stock/pedidos (lo más sensible del sistema) es lo más sólido de toda la auditoría.

---

## 5. Inventario para documentar

### 5.1 Pantallas del frontend (12)

| # | Archivo | Área | Descripción | Auth |
|---|---|---|---|---|
| 1 | `frontend/index.html` | home | Página de diagnóstico/setup (test de conexión API) | Ninguna |
| 2 | `frontend/login.html` | auth | Login (email + password) | Pública (redirige si ya hay sesión) |
| 3 | `frontend/cambiar-password.html` | auth | Cambio de contraseña (actual + nueva), usado también en primer login forzado | Cualquier usuario autenticado |
| 4 | `frontend/forgot-password.html` | auth | Pedido de recuperación de contraseña por email | Pública |
| 5 | `frontend/reset-password.html` | auth | Nueva contraseña vía token de la URL | Pública |
| 6 | `frontend/admin/index.html` | admin | Dashboard: stat cards, gráficos Chart.js, calendario, export CSV | admin |
| 7 | `frontend/admin/mesas.html` | admin/mozo | Mapa de salón, alta de mesas + QR, modal de operación/cobro | admin, mozo |
| 8 | `frontend/admin/productos.html` | admin | CRUD de productos del menú | admin |
| 9 | `frontend/admin/inventario.html` | admin | Stock por producto, ajuste manual, alertas OK/BAJO/AGOTADO | admin |
| 10 | `frontend/admin/usuarios.html` | admin | ABM de usuarios, filtros, vista lista/grilla, acciones masivas | admin |
| 11 | `frontend/cocina/pedidos.html` | cocina | Panel de pedidos activos, solo lectura, polling + WS | device_token (sin login) |
| 12 | `frontend/cliente/menu.html` | cliente | Menú público vía QR, carrito colaborativo, recomendaciones | Pública (qr_token en query string) |

### 5.2 Endpoints backend (48: 46 HTTP + 2 WebSocket)

**Raíz** (2): `GET /` · `GET /health`

**`/auth`** (7): `POST /register` · `POST /login` · `GET /me` · `GET /admin-only` · `POST /cambiar-password` · `POST /forgot-password` · `POST /reset-password`

**`/admin`** (5): `GET /usuarios` · `POST /usuarios` · `PATCH /usuarios/{id}/activo` · `PUT /usuarios/{id}` · `POST /usuarios/{id}/reenviar-bienvenida`

**`/productos`** (6): `GET /` · `GET /populares-hoy` · `GET /{id}` · `POST /` · `PUT /{id}` · `DELETE /{id}`

**`/mesas`** (10): `POST /` · `GET /` · `GET /mapa` · `GET /{id}/operacion` · `GET /{id}/cuenta` · `POST /{id}/cerrar` · `POST /{id}/liberar` · `POST /{id}/atender-mozo` · `GET /{id}/qr` · `POST /{id}/regenerar-qr`

**`/pedidos`** (6 HTTP + 2 WS): `WS /ws/cocina` (device_token) · `WS /ws/mesa` (qr_token, carrito colaborativo) · `POST /` · `POST /servicio` · `GET /` · `GET /activos-completos` · `GET /{id}` · `PATCH /{id}/estado`

**`/reportes`** (5, todos admin): `GET /ventas` (CSV) · `GET /dashboard` · `GET /resumen-hoy` (CSV) · `GET /ventas-hoy` · `GET /ventas-semana`

**`/inventario` + `/movimientos-stock`** (4, todos admin): `GET /inventario/` · `GET /inventario/bajo-minimo` · `PUT /inventario/{id}` · `POST /inventario/{id}/entrada` · `GET /movimientos-stock/`

*(Detalle completo con archivo:línea y rol exacto disponible en el historial de esta auditoría — se puede volcar tal cual a la carpeta técnica.)*

### 5.3 Tablas de la base de datos (12, para el diagrama ER)

| Tabla | Rol |
|---|---|
| `usuarios` | Cuentas admin/mozo |
| `mesas` | Mesas físicas del salón (`estado` es columna muerta — ver §4) |
| `mesa_estado_operativo` | 1:1 con `mesas`, estado operativo en vivo (ocupada, cuenta/mozo solicitados) |
| `mesa_sesiones_snapshot` | Espejo en DB del carrito colaborativo en memoria (sin FK a `mesas`) |
| `categorias` | Categorías del menú |
| `productos` | Productos del menú (+ `stock_actual`/`stock_minimo` de migración 010) |
| `pedidos` | Pedidos, con timestamps por estado y FK a `mesas`/`usuarios` |
| `detalle_pedidos` | Ítems de cada pedido (snapshot de `precio_unitario`) |
| `cierres_mesa` | Registro de cobro por mesa |
| `cierre_pedidos` | Relación N:M cierre↔pedido, `UNIQUE(id_pedido)` = "no se cobra dos veces" |
| `movimientos_stock` | Historial de entradas/salidas/ajustes de stock (migración 010) |
| `password_reset_tokens` | Tokens de recuperación de contraseña, un solo uso (migración 011) |

Nota para el ER: 3 columnas/tablas de este listado **no están en `docs/database.sql`** tal cual está hoy en el repo — requieren aplicar las migraciones 007/010/011 para existir realmente (ver §3.1). Si se genera el diagrama desde `docs/database.sql` sin más, va a faltar `movimientos_stock`, `password_reset_tokens` y la columna `must_change_password`.

---

## Nota metodológica

Esta revisión no modificó ningún archivo del repositorio. Se usó `origin/dev` en un checkout separado (detached HEAD) para no interferir con el trabajo en curso en la rama `fix/ui-mozo-menu`; los cambios locales sin commitear de esa rama (`CLAUDE.md`, `AUDITORIA_FINAL.md`) se guardaron en un stash antes de cambiar de rama y se restauraron al finalizar.
