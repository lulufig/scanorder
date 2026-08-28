// ============================================================
//  auth.js — Gestión de autenticación y sesión (JWT)
//
//  Contrato con el backend (routes/auth.py):
//
//  POST /auth/login  →  responde:
//  {
//    "access_token": "<jwt>",
//    "token_type": "bearer",
//    "user": {
//      "id_usuario": 1,
//      "nombre": "...",
//      "email": "...",
//      "rol": "admin" | "mozo",
//      "activo": true
//    }
//  }
//
//  Rutas protegidas esperan header:
//    Authorization: Bearer <token>
// ============================================================

const TOKEN_KEY = "scanorder_token";
const USER_KEY  = "scanorder_user";
const SESSION_STORE = window.sessionStorage;
const LEGACY_STORE = window.localStorage;

/**
 * Guarda el token JWT en sessionStorage.
 * @param {string} token
 */
function saveToken(token) {
  SESSION_STORE.setItem(TOKEN_KEY, token);
  LEGACY_STORE.removeItem(TOKEN_KEY);
}

/**
 * Recupera el token JWT almacenado.
 * @returns {string|null}
 */
function getToken() {
  const token = SESSION_STORE.getItem(TOKEN_KEY) || LEGACY_STORE.getItem(TOKEN_KEY);
  if (token && !SESSION_STORE.getItem(TOKEN_KEY)) {
    SESSION_STORE.setItem(TOKEN_KEY, token);
    LEGACY_STORE.removeItem(TOKEN_KEY);
  }
  return token;
}

/**
 * Guarda en sessionStorage el objeto user que devuelve el backend en /auth/login.
 * Estructura: { id_usuario, nombre, email, rol, activo }
 * @param {Object} user
 */
function saveUser(user) {
  SESSION_STORE.setItem(USER_KEY, JSON.stringify(user));
  LEGACY_STORE.removeItem(USER_KEY);
}

/**
 * Recupera los datos del usuario autenticado.
 * @returns {{ id_usuario, nombre, email, rol, activo } | null}
 */
function getUser() {
  const raw = SESSION_STORE.getItem(USER_KEY) || LEGACY_STORE.getItem(USER_KEY);
  if (raw && !SESSION_STORE.getItem(USER_KEY)) {
    SESSION_STORE.setItem(USER_KEY, raw);
    LEGACY_STORE.removeItem(USER_KEY);
  }
  return raw ? JSON.parse(raw) : null;
}

/**
 * Devuelve el rol del usuario actual ("admin" | "mozo" | null).
 * @returns {string|null}
 */
function getUserRole() {
  const user = getUser();
  return user ? user.rol : null;
}

/**
 * Devuelve el nombre del usuario actual.
 * @returns {string|null}
 */
function getUserNombre() {
  const user = getUser();
  return user ? user.nombre : null;
}

/**
 * Cierra la sesión: elimina token y datos de usuario,
 * y redirige al login.
 */
function logout() {
  SESSION_STORE.removeItem(TOKEN_KEY);
  SESSION_STORE.removeItem(USER_KEY);
  LEGACY_STORE.removeItem(TOKEN_KEY);
  LEGACY_STORE.removeItem(USER_KEY);
  window.location.href = ROUTES.login;
}

/**
 * Verifica si hay una sesión activa (token presente).
 * @returns {boolean}
 */
function isLoggedIn() {
  return !!getToken();
}

/**
 * Protege una página: si no hay sesión redirige al login.
 * Acepta uno o varios roles permitidos.
 *
 * Uso al inicio de cada página protegida:
 *   requireAuth(ROLES.ADMIN);               → solo admin
 *   requireAuth(ROLES.ADMIN, ROLES.MOZO);   → admin o mozo
 *
 * @param {...string} requiredRoles
 */
function requireAuth(...requiredRoles) {
  if (!isLoggedIn()) {
    window.location.href = ROUTES.login;
    return false;
  }
  if (requiredRoles.length > 0 && !requiredRoles.includes(getUserRole())) {
    const role = getUserRole();
    if (role === ROLES.ADMIN)  window.location.href = ROUTES.admin;
    else if (role === ROLES.MOZO) window.location.href = ROUTES.mesas;
    else                       window.location.href = ROUTES.login;
    return false;
  }
  return true;
}

/**
 * Oculta del menú lateral (y de cualquier bloque marcado) las secciones
 * que el rol actual no debería ver. Es solo UX: el backend ya valida
 * permisos por endpoint, esto no reemplaza esa protección.
 *
 * Marcar los elementos a ocultar con el atributo `data-role="admin"`.
 * Llamar después de requireAuth() en cada página protegida.
 */
function applyRoleVisibility() {
  const role = getUserRole();

  // Etiqueta del bloque de usuario en el sidebar según el rol.
  const rolLabel = document.getElementById("sidebar-rol-label");
  if (rolLabel) {
    rolLabel.textContent = role === ROLES.MOZO ? "Mozo" : "Administración";
  }

  if (role === ROLES.ADMIN) return;
  document.querySelectorAll('[data-role="admin"]').forEach((el) => {
    el.style.display = "none";
  });
}
