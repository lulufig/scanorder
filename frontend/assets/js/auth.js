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

/**
 * Guarda el token JWT en localStorage.
 * @param {string} token
 */
function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Recupera el token JWT almacenado.
 * @returns {string|null}
 */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Guarda el objeto user que devuelve el backend en /auth/login.
 * Estructura: { id_usuario, nombre, email, rol, activo }
 * @param {Object} user
 */
function saveUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Recupera los datos del usuario autenticado.
 * @returns {{ id_usuario, nombre, email, rol, activo } | null}
 */
function getUser() {
  const raw = localStorage.getItem(USER_KEY);
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
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
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
    return;
  }
  if (requiredRole && getUserRole() !== requiredRole) {
    // Redirige al panel correcto según el rol real del usuario
    const role = getUserRole();
    if (role === ROLES.ADMIN)  window.location.href = ROUTES.admin;
    if (role === ROLES.COCINA) window.location.href = ROUTES.cocina;
  }
}