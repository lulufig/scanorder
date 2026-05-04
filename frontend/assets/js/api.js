// ============================================================
//  api.js — Cliente HTTP genérico para el backend ScanOrder
//
//  Contrato con el backend:
//  - Header de autenticación: "Authorization: Bearer <token>"
//  - Errores del backend llegan como: { "detail": "mensaje" }
//  - 401 en rutas protegidas = token inválido/expirado → se cierra la sesión
// ============================================================

/**
 * Realiza una llamada a la API del backend.
 *
 * @param {string} endpoint    - Ruta relativa, ej: "/productos" o "/auth/login"
 * @param {string} method      - Método HTTP: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
 * @param {Object|null} body   - Cuerpo de la solicitud (se serializa a JSON automáticamente)
 * @param {boolean} auth       - Si es true, incluye el token JWT en el header Authorization
 * @returns {Promise<Object>}  - Respuesta parseada como JSON
 * @throws {ApiError}          - Lanza un error con mensaje y código HTTP si la llamada falla
 */
async function fetchAPI(endpoint, method = "GET", body = null, auth = true) {
  const headers = {
    "Content-Type": "application/json",
  };

  // El backend espera: "Authorization: Bearer <token>"
  if (auth) {
    const token = getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const options = { method, headers };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, options);
  } catch (networkError) {
    throw new ApiError(
      "No se pudo conectar con el servidor. Verificá que el backend esté corriendo en " + API_URL,
      0
    );
  }

  // 401 en rutas protegidas: token inválido o expirado → cerrar sesión.
  // En rutas públicas (auth=false), se devuelve el error sin redirigir al login.
  if (auth && response.status === 401) {
    logout();
    throw new ApiError("Sesión expirada. Iniciá sesión nuevamente.", 401);
  }

  // Intentamos parsear la respuesta como JSON
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    // FastAPI devuelve los errores como { "detail": "mensaje" }
    const message = data?.detail || `Error ${response.status}: ${response.statusText}`;
    throw new ApiError(message, response.status);
  }

  return data;
}

/**
 * Descarga un archivo binario desde el backend (PDF de reportes, imagen QR).
 *
 * @param {string} endpoint   - Ruta relativa del recurso, ej: "/mesas/3/qr"
 * @param {string} filename   - Nombre con el que se guardará el archivo, ej: "mesa3.png"
 */
async function downloadFile(endpoint, filename) {
  const token = getToken();
  const headers = token ? { "Authorization": `Bearer ${token}` } : {};

  let response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, { headers });
  } catch {
    throw new ApiError("No se pudo descargar el archivo. Verificá la conexión.", 0);
  }

  if (!response.ok) {
    throw new ApiError(`Error al descargar el archivo (${response.status})`, response.status);
  }

  const blob = await response.blob();
  const url  = URL.createObjectURL(blob);

  const link    = document.createElement("a");
  link.href     = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---- Clase de error personalizada ----

class ApiError extends Error {
  /**
   * @param {string} message  - Mensaje legible para mostrar al usuario
   * @param {number} status   - Código HTTP (0 = error de red, sin respuesta del servidor)
   */
  constructor(message, status = 0) {
    super(message);
    this.name   = "ApiError";
    this.status = status;
  }
}
