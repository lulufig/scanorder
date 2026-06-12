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
//      "rol": "admin" | "cocina",
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
 * Devuelve el rol del usuario actual ("admin" | "cocina" | null).
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
 * Si se pasa un rol requerido, también verifica el rol.
 *
 * Uso al inicio de cada página protegida:
 *   requireAuth();             → solo verifica sesión
 *   requireAuth(ROLES.ADMIN);  → verifica sesión + rol admin
 *   requireAuth(ROLES.COCINA); → verifica sesión + rol cocina
 *
 * @param {string|null} requiredRole
 */
function requireAuth(requiredRole = null) {
  if (!isLoggedIn()) {
    window.location.href = ROUTES.login;
    return false;
  }
  if (requiredRole && getUserRole() !== requiredRole) {
    const role = getUserRole();
    if (role === ROLES.ADMIN)       window.location.href = ROUTES.admin;
    else if (role === ROLES.COCINA) window.location.href = ROUTES.cocina;
    else                            window.location.href = ROUTES.login;
    return false;
  }
  return true;
}
