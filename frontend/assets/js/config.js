// ============================================================
//  config.js — Configuración global del frontend ScanOrder
// ============================================================

const API_URL = "http://localhost:8000";

// Rutas de la aplicación
const ROUTES = {
  login:    "/login.html",
  admin:    "/admin/index.html",
  cocina:   "/cocina/pedidos.html",
  menu:     "/cliente/menu.html",
};

// Roles válidos — tienen que coincidir exactamente con los
// valores que guarda el backend en la tabla usuarios.rol
const ROLES = {
  ADMIN:  "admin",
  COCINA: "cocina",
};

// Tiempo de polling para el panel de cocina (ms)
const POLLING_INTERVAL = 5000;