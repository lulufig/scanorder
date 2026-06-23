// ============================================================
//  config.js — Configuración global del frontend ScanOrder
// ============================================================

const API_HOST = window.location.hostname || "localhost";
const API_PROTOCOL = window.location.protocol === "file:" ? "http:" : window.location.protocol;
const API_URL = window.SCANORDER_API_URL || `${API_PROTOCOL}//${API_HOST}:8000`;

// Rutas de la aplicación
const ROUTES = {
  login:    "/frontend/login.html",
  admin:    "/frontend/admin/index.html",
  mesas:    "/frontend/admin/mesas.html",
  cocina:   "/frontend/cocina/pedidos.html",
  menu:     "/frontend/cliente/menu.html",
};

// Roles válidos — tienen que coincidir exactamente con los
// valores que guarda el backend en la tabla usuarios.rol.
// El panel de cocina ya NO usa rol de usuario: usa COCINA_DEVICE_TOKEN.
const ROLES = {
  ADMIN: "admin",
  MOZO:  "mozo",
};

// Tiempo de polling para el panel de cocina (ms)
const POLLING_INTERVAL = 5000;
