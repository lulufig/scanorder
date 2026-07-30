# Auditoría final — ScanOrder vs. requisitos del TFI

Auditoría de solo lectura. Generada el 2026-06-30 sobre el branch `dev`. Veredictos: **CUMPLE** / **NO CUMPLE** / **PARCIAL**, con evidencia de archivo y función. Todo el código citado fue verificado leyendo el archivo real (no se confía solo en la documentación de `CLAUDE.md`).

---

## 1. Gestión de usuarios

### 1.1 ABM de usuarios — **PARCIAL**

| Operación | Veredicto | Evidencia |
|---|---|---|
| Alta | CUMPLE | `POST /admin/usuarios` — `backend/app/routes/admin.py:67-127`. Genera password temporal de 10 caracteres, `must_change_password=TRUE`, envía email de bienvenida. Rol requerido: admin. |
| Baja | PARCIAL (solo lógica) | `PATCH /admin/usuarios/{id_usuario}/activo` — `backend/app/routes/admin.py:132-164`. Alterna el booleano `activo` (no hay DELETE físico). Columna `usuarios.activo BOOLEAN DEFAULT TRUE` en `docs/database.sql:23`. |
| Modificación | **NO CUMPLE** | No existe ningún endpoint `PUT`/`PATCH` que permita editar nombre, email o rol de un usuario existente. El único `PATCH` de `admin.py` es el de activo/inactivo (confirmado: `grep` de `@router.(put|patch)` en `admin.py` solo devuelve esa línea). El frontend (`frontend/admin/usuarios.html`) tampoco tiene modal de edición — solo modal de alta y botones de activar/desactivar y reenviar bienvenida. |
| Consulta | CUMPLE | `GET /admin/usuarios` — `admin.py:41` (lista, sin exponer `password_hash`). |

**Conclusión: el ABM está incompleto** — falta la "M" (modificación) de datos de usuario. Si el evaluador pide ABM estricto de 4 operaciones, esto es un punto a señalar y, de ser posible, a resolver antes de la entrega agregando un `PUT /admin/usuarios/{id}`.

### 1.2 Login con validación de credenciales — **CUMPLE**

- `POST /auth/login` — `backend/app/routes/auth.py:118-177`.
- Busca usuario activo por email; si no existe → `401`. Verifica password con `verify_password()` (bcrypt vía passlib, `backend/app/utils/security.py:22-28`); si no coincide → `401`.
- Devuelve JWT (`access_token`) + datos de usuario + `must_change_password`.

### 1.3 Roles diferenciados (mínimo 2) — **CUMPLE**

- `usuarios.rol ENUM('admin','mozo')` — `docs/database.sql:22`. Dos roles.
- `require_role(*required_roles)` — `backend/app/utils/dependencies.py:59-75`, variadic, devuelve `403` si el rol no está permitido. Usado en 15+ endpoints (`admin.py`, `mesas.py`, `inventario.py`, `pedidos.py`).

### 1.4 Recuperación de contraseña — **CUMPLE**

- `POST /auth/forgot-password` (`auth.py:293-338`): rate limit 3/email/hora en memoria, nunca confirma si el email existe, genera token con `secrets`, expira a 30 min (tabla `password_reset_tokens`, migración `011_auth_complete.sql`).
- `POST /auth/reset-password` (`auth.py:348-417`): valida token no usado y no expirado, actualiza `password_hash`, marca token usado.
- Envío real de email vía `smtplib.SMTP_SSL` en `backend/app/services/email_service.py` (no es un stub) — degrada en silencio (WARNING en logs) si `GMAIL_USER`/`GMAIL_APP_PASSWORD` no están configuradas.

---

## 2. Funcionalidad CRUD

Revisado endpoint por endpoint en `backend/app/routes/*.py`.

| Entidad | Alta | Baja | Modificación | Consulta | Veredicto |
|---|---|---|---|---|---|
| **Productos** | `POST /productos/` (`productos.py:211`) | `DELETE /productos/{id}` — baja lógica, `disponible=FALSE` (`productos.py:358`) | `PUT /productos/{id}` (`productos.py:277`) | `GET /productos/` y `GET /productos/{id}` (`productos.py:101,180`) | **CUMPLE COMPLETO** |
| **Pedidos** | `POST /pedidos/` (`pedidos.py:209`) | estado `cancelado` (vía `PATCH .../estado`, no DELETE) | `PATCH /pedidos/{id}/estado` (`pedidos.py:647`) | `GET /pedidos/` y `GET /pedidos/{id}` (`pedidos.py:426,568`) | CUMPLE (modelo de transición de estados, no ABM clásico) |
| **Usuarios** | `POST /admin/usuarios` | `PATCH .../activo` (lógica) | **No existe** | `GET /admin/usuarios` | PARCIAL (ver §1.1) |
| **Mesas** | `POST /mesas/` (`mesas.py:66`) | **No existe** (ni física ni lógica — no hay endpoint que togglee `mesas.activa`, solo se usa internamente en queries vía `mesa_tiene_columna`) | `POST /mesas/{id}/regenerar-qr` (`mesas.py:816`, modificación parcial) | `GET /mesas/` y `GET /mesas/mapa` (`mesas.py:132,197`) | PARCIAL |
| **Inventario/Stock** | `POST /inventario/{id}/entrada` (`inventario.py`) | N/A (no aplica baja en este dominio) | `PUT /inventario/{id}` (ajuste manual) | `GET /inventario/`, `GET /inventario/bajo-minimo`, `GET /movimientos-stock/` | CUMPLE (entidad derivada de productos) |
| **Categorías** | Solo indirecta, dentro de `resolver_id_categoria()` en `productos.py` | No existe | No existe | Indirecta vía JOIN en productos | NO EXISTE CRUD independiente |

**Las 2+ entidades con CRUD 100% completo (alta, baja, modificación, consulta) requeridas por la consigna son: Productos y Pedidos** (este último con baja modelada como cambio de estado, que es el patrón correcto para un sistema de pedidos — no se "borran" pedidos por trazabilidad/auditoría).

**Nota importante de verificación:** confirmé con `grep` que el frontend (`frontend/admin/js/productos.js:180-220`) sí invoca `PUT /productos/{id}` y `DELETE /productos/{id}` — el CRUD de productos está conectado end-to-end, no solo a nivel de backend.

---

## 3. Persistencia

### 3.1 Base de datos relacional — **CUMPLE**

MySQL, `ENGINE=InnoDB` en todas las tablas de `docs/database.sql`, `utf8mb4`.

### 3.2 Claves primarias y foráneas — **CUMPLE**

| Tabla | PK | FKs salientes |
|---|---|---|
| usuarios | id_usuario | — |
| mesas | id_mesa | — |
| categorias | id_categoria | — |
| productos | id_producto | → categorias (ON DELETE RESTRICT) |
| pedidos | id_pedido | → mesas, → usuarios (ON DELETE SET NULL) |
| detalle_pedidos | id_detalle | → pedidos (ON DELETE CASCADE), → productos (ON DELETE RESTRICT) |
| mesa_estado_operativo | id_mesa | → mesas (ON DELETE CASCADE) |
| cierres_mesa | id_cierre | → mesas, → usuarios (ON DELETE SET NULL) |
| cierre_pedidos | id_cierre_pedido | → cierres_mesa (CASCADE), → pedidos (RESTRICT) |
| movimientos_stock | id | → productos, → pedidos, → usuarios |
| password_reset_tokens | id | → usuarios (CASCADE) |

Cascadas coherentes: se borra en cascada lo que es puramente dependiente (detalle de un pedido, snapshot de estado de una mesa), y se restringe/anula lo que tiene valor de auditoría (no se puede borrar un producto con pedidos asociados; si se borra un usuario, sus pedidos/cierres quedan con `id_usuario=NULL` en vez de desaparecer).

### 3.3 Validaciones de integridad — **CUMPLE**

- `CHECK`: `pedidos.estado IN (...)`, `productos.stock_actual >= 0`, `movimientos_stock.cantidad != 0`.
- `ENUM`: `usuarios.rol`, `cierres_mesa.metodo_pago`.
- `UNIQUE`: `usuarios.email`, `mesas.qr_token`, `password_reset_tokens.token`.
- `NOT NULL` y `DEFAULT` en columnas críticas (timestamps, booleans).

### 3.4 Normalización (3FN) — **PARCIAL**

Hay redundancias deliberadas que un evaluador estricto puede señalar como violaciones de 3FN:

1. **`detalle_pedidos.subtotal`** (`docs/database.sql` ~línea 216-217): es `cantidad × precio_unitario`, un valor calculable que se persiste en vez de derivarse. Dependencia funcional de otras dos columnas no-clave de la misma fila.
2. **`cierres_mesa.numero_mesa`**: duplica `mesas.numero`, alcanzable vía la FK `id_mesa`. Mismo patrón en `mesa_sesiones_snapshot.numero_mesa`.
3. **`detalle_pedidos.precio_unitario`** (distinto del punto 1) **no** es una violación — es una captura intencional del precio histórico al momento del pedido, necesaria porque `productos.precio` puede cambiar después. Esto es una práctica correcta de "snapshot de precio", común en sistemas de facturación, y no debe confundirse con redundancia.

**Cómo presentarlo ante el evaluador:** el modelo cumple 1FN/2FN sin objeciones. Las violaciones de 3FN son puntuales (2-3 columnas calculadas/duplicadas) y están justificadas por motivos de performance de consulta y trazabilidad histórica — no por falta de diseño. Si se quiere blindar el punto, lo más simple es poder explicar oralmente por qué `subtotal` y `numero_mesa` están desnormalizados a propósito.

---

## 4. Calidad de código

### 4.1 Separación de responsabilidades — **CUMPLE**

Arquitectura en 3 capas: `routes/` (controladores) → `services/` (lógica de negocio) → `repositories/` (acceso a datos).

- `routes/pedidos.py` (`create_pedido`, líneas 209-344) delega validación de stock a `inventory_service.validar_stock_batch()`, descuento a `descontar_stock_pedido()`, notificación a `notification_service.notify()`.
- `services/mesa_state.py` (`MesaOperationalState`) delega la persistencia a `repositories/mesa_state_repo.py::persist_operational_state()` — el repositorio no contiene lógica de negocio, solo SQL.
- **Excepción real:** `routes/pedidos.py:244-273` ejecuta queries de validación de productos/cálculo de subtotal directamente en la route, sin pasar por un servicio dedicado. Es un punto de mezcla controller+SQL que un evaluador puede señalar, aunque no es grave (es validación de pre-condición antes de delegar el resto).

### 4.2 Modularidad — **CUMPLE**

Ejemplos de funciones/clases reutilizables: `validate_qr_token()` (`pedidos.py`, usada en `create_pedido`, `solicitar_servicio` y el handshake WS), `require_role()` (usado en 15+ endpoints), interfaz `NotificationService` con 3 implementaciones intercambiables (`services/notifications.py`).

### 4.3 Manejo de errores — **CUMPLE**

Patrón consistente: `try/except/finally` con `connection.rollback()` en el except y cierre de cursor/conexión en el finally (`pedidos.py`, `mesas.py::cerrar_mesa`). Los `except` genéricos que "tragan" errores sin relanzar están documentados y son intencionales (cleanup post-commit en `mesas.py`, notificaciones best-effort en `notifications.py`) — no se encontraron casos de manejo de errores silencioso no justificado.

---

## 5. Reportes (excluyente)

### 5.1 Visualización en pantalla — **CUMPLE**

`GET /reportes/dashboard` (`backend/app/routes/reportes.py:173-306`) devuelve JSON con ventas/pedidos del día, ticket promedio, producto/mesa top, cobros por método de pago. Consumido desde `frontend/admin/js/index.js:29`.

### 5.2 Exportación CSV — **CUMPLE**

| Endpoint | Función | Frontend |
|---|---|---|
| `GET /reportes/ventas` | `reportes.py:47-159` | `admin/js/index.js:265` |
| `GET /reportes/resumen-hoy` | `reportes.py:309-493` | `admin/js/index.js:324` |

Ambos usan `io.StringIO` + `csv.writer`, BOM UTF-8 (`\xef\xbb\xbf`) y `sep=;` como primera línea — convención para que Excel los abra con el encoding/separador correcto.

**Precisión importante:** esto es **CSV, no un .xlsx/PDF real**. No hay `openpyxl`/`xlsxwriter`/`reportlab` (este último fue removido según `CLAUDE.md`). Si la consigna pide explícitamente "Excel" como formato binario, esto sería un punto débil — pero un CSV con BOM que Excel abre correctamente suele aceptarse como cumplimiento de "exportación a CSV/Excel".

---

## 6. Cobertura de tests

**Corregido tras verificación directa con `grep` (el conteo inicial con patrón `^def test_` subestimaba el total al no contar tests indentados dentro de clases):**

| Archivo | Tests | Cobertura |
|---|---|---|
| `test_caract_pedidos.py` | 17 | Caracterización de transiciones de estado de pedidos (pre-refactor) |
| `test_roles_mozo.py` | 22 | Permisos admin vs. mozo en distintos endpoints |
| `test_auth_complete.py` | 22 | Alta de usuario, email duplicado, forgot/reset password, rate limit, cambiar password |
| `test_inventory.py` | 20 | Validación de stock, descuento al entregar, ajustes manuales, race condition de stock negativo |
| `test_reportes_dashboard.py` | 17 | Dashboard JSON, CSV de resumen-hoy (BOM, secciones, serie horaria) |
| `test_notifications.py` | 13 | `NotificationService`, construcción de `TwilioWhatsAppNotifier` según env vars |
| `test_mesas_cierre.py` | 4 | Integración contra MySQL real: atomicidad del cierre de mesa, guarda anti-doble-cierre |
| `test_productos.py` | 4 | CRUD de productos |
| `test_pedidos.py` | 3 | Creación de pedidos |
| **Total** | **122** | — |

Tipo de tests: mayoría unitarios con cursores/conexión mockeados (`unittest.mock`); `test_mesas_cierre.py` es de integración contra una base MySQL real (se salta con `pytest.mark.skipif` si la DB no está disponible). Buena cobertura de los flujos críticos de negocio (stock, cierre de mesa, roles, auth). No hay tests de `mesas.py` para el mapa de mesas/estado de salón ni para `mesa_sessions.py` (carrito colaborativo) — es la superficie más compleja del proyecto (~1100 líneas en `pedidos.py`, WS) y la que menos tests directos tiene.

---

## 7. Código muerto, TODOs, endpoints no usados, deuda técnica

- **TODO explícito:** `services/notifications.py` — `EscPosPrinterNotifier` es un stub documentado para integrar impresora térmica ESC/POS (no implementado, declarado a propósito como trabajo futuro).
- **Endpoints de admin sin UI dedicada en frontend** (existen y funcionan, pero no se consumen desde ninguna pantalla más allá de `usuarios.html`): esto es esperable, no es código muerto real, salvo que se quiera presentar como gap de producto.
- **Mesas sin baja lógica:** la columna `mesas.activa` existe en el schema y se lee defensivamente (`mesa_tiene_columna`), pero no hay ningún endpoint que la modifique — es una columna que nunca se escribe desde la aplicación. Vale la pena mencionarlo si un evaluador pregunta puntualmente por baja de mesas.
- **Falta de PUT de usuario** (ver §1.1) es la deuda técnica más visible de cara a la consigna del TFI — es el único requisito obligatorio (ABM completo) con un NO CUMPLE claro y fácil de defender con poco esfuerzo si se decide resolver antes de la entrega.
- **Redundancias de modelo** (`subtotal`, `numero_mesa` duplicado) — ver §3.4, defendibles oralmente pero técnicamente desnormalizadas.
- **Rate limiting en memoria** (`forgot-password`) y **estado runtime en memoria con espejo a DB** (`MesaSessionManager`, `MesaOperationalState`) son decisiones de diseño ya documentadas y aceptadas en `CLAUDE.md` como límites conocidos del MVP académico — no son hallazgos nuevos de esta auditoría, pero un evaluador puede preguntar por ellas.

---

## Resumen ejecutivo

| Requisito | Veredicto |
|---|---|
| ABM de usuarios | **PARCIAL** — falta modificación |
| Login con validación | CUMPLE |
| Roles diferenciados (≥2) | CUMPLE |
| Recuperación de contraseña | CUMPLE |
| CRUD completo en ≥2 entidades | CUMPLE — Productos y Pedidos |
| Base de datos relacional | CUMPLE |
| PK/FK definidas | CUMPLE |
| Validaciones de integridad | CUMPLE |
| Normalización 3FN | PARCIAL — redundancias puntuales y justificables |
| Separación de capas | CUMPLE |
| Modularidad | CUMPLE |
| Manejo de errores | CUMPLE |
| Reportes en pantalla | CUMPLE |
| Exportación CSV | CUMPLE (no es .xlsx/PDF real) |

**Único punto con NO CUMPLE directo: falta el endpoint de modificación de usuarios (PUT/PATCH de nombre/email/rol).** Es el ítem de menor esfuerzo para resolver antes de la entrega si se quiere blindar el ABM al 100%. Todo lo demás está en CUMPLE o PARCIAL-defendible con justificación técnica documentada.
