
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    // Solo usuarios con rol "cocina" pueden acceder
    requireAuth(ROLES.COCINA);

    const usuario = getUser();
    if (usuario) {
      document.getElementById("topbar-nombre").textContent = usuario.nombre;
    }

    // ── ESTADO ──────────────────────────────────────────────────
    let pedidos        = { pendiente: [], confirmado: [], en_preparacion: [], listo: [] };
    let pollingTimer   = null;
    let primeraVez     = true;
    let enCambioEstado = new Set(); // IDs de pedidos con acción en progreso

    // ── ARRANCAR POLLING ─────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
      cargarPedidos();
      conectarTiempoReal();
      pollingTimer = setInterval(cargarPedidos, POLLING_INTERVAL);
    });

    // Pausar polling si la pestaña queda en segundo plano
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(pollingTimer);
        document.getElementById("polling-dot").classList.add("paused");
        document.getElementById("polling-label").textContent = "En pausa";
      } else {
        cargarPedidos();
        pollingTimer = setInterval(cargarPedidos, POLLING_INTERVAL);
        document.getElementById("polling-dot").classList.remove("paused");
      }
    });

    // ── CARGAR PEDIDOS ───────────────────────────────────────────
    async function cargarPedidos() {
      try {
        // GET /pedidos — devuelve todos los pedidos activos
        // El backend filtra por estado si se pasa ?estado=pendiente
        // Traemos todos para mostrar las columnas de cocina
        const lista = await fetchAPI("/pedidos");
        const base  = Array.isArray(lista) ? lista : [];

        // GET /pedidos/{id} para cada pedido — trae el detalle de productos
        const conDetalle = (await Promise.all(
          base.map(p =>
            fetchAPI(`/pedidos/${p.id_pedido}`).catch(() => p)
          )
        )).filter(Boolean); // descarta cualquier resultado null/undefined

        // Separar por estado
        pedidos.pendiente      = conDetalle.filter(p => p.estado === "pendiente");
        pedidos.confirmado     = conDetalle.filter(p => p.estado === "confirmado");
        pedidos.en_preparacion = conDetalle.filter(p => p.estado === "en_preparacion");
        pedidos.listo          = conDetalle.filter(p => p.estado === "listo");

        actualizarStats();
        renderColumnas();

        // Actualizar indicador de polling
        const ahora = new Date();
        document.getElementById("last-update").textContent =
          `Última actualización: ${ahora.toLocaleTimeString("es-AR")}`;
        document.getElementById("polling-label").textContent = "En vivo";

        primeraVez = false;

      } catch (error) {
        document.getElementById("polling-label").textContent = "Error";
        if (primeraVez) {
          document.getElementById("columnas").innerHTML = `
            <div class="loading-screen" style="grid-column:1/-1;">
              <p style="color:#ef4444;"> No se pudo cargar los pedidos: ${escapeHtml(error.message)}</p>
            </div>`;
        }
      }
    }

    // ── STATS ────────────────────────────────────────────────────
    function actualizarStats() {
      document.getElementById("count-pendiente").textContent   = pedidos.pendiente.length;
      document.getElementById("count-confirmado").textContent  = pedidos.confirmado.length;
      document.getElementById("count-preparacion").textContent = pedidos.en_preparacion.length;
      document.getElementById("count-listo").textContent       = pedidos.listo.length;
    }

    // ── RENDER DE COLUMNAS ───────────────────────────────────────
    function renderColumnas() {
      document.getElementById("columnas").innerHTML = `
        ${renderColumna("pendiente",      "amarillo", " Pendientes",      pedidos.pendiente)}
        ${renderColumna("confirmado",     "rojo",     " Confirmados",     pedidos.confirmado)}
        ${renderColumna("en_preparacion", "naranja",  " En preparación",  pedidos.en_preparacion)}
        ${renderColumna("listo",          "verde",    " Listos",           pedidos.listo)}
      `;
    }

    function renderColumna(estado, color, titulo, lista) {
      const cards = lista.length === 0
        ? `<div class="columna-empty">
             <div class="icon">
               ${estado === "pendiente" ? "PEN" : estado === "confirmado" ? "CONF" : estado === "en_preparacion" ? "PREP" : "LISTO"}
             </div>
             <p>${estado === "pendiente" ? "Sin pedidos nuevos" : estado === "confirmado" ? "Sin pedidos confirmados" : estado === "en_preparacion" ? "Nada en preparación" : "Aún no hay pedidos listos"}</p>
           </div>`
        : lista.map(p => renderPedidoCard(p, estado, color)).join("");

      return `
        <div class="columna">
          <div class="columna-header">
            <div class="columna-titulo ${color}">${titulo}</div>
            <div class="columna-count ${color}">${lista.length}</div>
          </div>
          ${cards}
        </div>`;
    }

    // ── RENDER DE CADA CARD DE PEDIDO ────────────────────────────
    function renderPedidoCard(pedido, estado, color) {
      const hora      = pedido.fecha ? formatHora(pedido.fecha) : "—";
      const tiempo    = pedido.fecha ? calcularTiempo(pedido.fecha) : null;
      const productos = pedido.detalle || [];
      const total     = pedido.total || calcularTotal(productos);

      // Clase de urgencia según tiempo transcurrido
      let tiempoClass = "ok";
      let tiempoLabel = "";
      if (tiempo !== null) {
        if (tiempo > 20)       { tiempoClass = "urgente"; tiempoLabel = ` ${tiempo}m`; }
        else if (tiempo > 10)  { tiempoClass = "normal";  tiempoLabel = `${tiempo}m`; }
        else                   { tiempoClass = "ok";      tiempoLabel = `${tiempo}m`; }
      }

      // Botones según estado
      let acciones = "";
      if (estado === "pendiente") {
        acciones = `
          <button class="btn-accion btn-preparar"
                  id="btn-${pedido.id_pedido}"
                  onclick="cambiarEstado(${pedido.id_pedido}, 'confirmado')">Confirmar
          </button>`;
      } else if (estado === "confirmado") {
        acciones = `
          <button class="btn-accion btn-preparar"
                  id="btn-${pedido.id_pedido}"
                  onclick="cambiarEstado(${pedido.id_pedido}, 'en_preparacion')">
             En preparación
          </button>`;
      } else if (estado === "en_preparacion") {
        acciones = `
          <button class="btn-accion btn-listo"
                  id="btn-${pedido.id_pedido}"
                  onclick="cambiarEstado(${pedido.id_pedido}, 'listo')">Marcar listo
          </button>`;
      } else if (estado === "listo") {
        acciones = `
          <button class="btn-accion btn-entregar"
                  id="btn-${pedido.id_pedido}"
                  onclick="cambiarEstado(${pedido.id_pedido}, 'entregado')">Entregado
          </button>`;
      }

      return `
        <div class="pedido-card ${color}" id="card-${pedido.id_pedido}">

          <div class="pedido-header">
            <div>
              <div class="pedido-mesa"> Mesa ${pedido.id_mesa || "—"}</div>
              <div class="pedido-id">#${pedido.id_pedido}</div>
            </div>
            <div class="pedido-hora">
              ${hora}
              ${tiempoLabel ? `<div class="pedido-tiempo ${tiempoClass}">${tiempoLabel}</div>` : ""}
            </div>
          </div>

          <div class="pedido-items">
            ${productos.length > 0
              ? productos.map(item => `
                  <div class="pedido-item">
                    <span class="pedido-item-nombre">
                      ${escapeHtml(item.nombre || item.producto_nombre || "Producto")}
                    </span>
                    <span class="pedido-item-cantidad ${color}">×${item.cantidad}</span>
                  </div>`).join("")
              : `<div class="pedido-item" style="color:var(--text-dim); font-size:0.8rem;">
                   Sin detalle disponible
                 </div>`
            }
          </div>

          ${pedido.observaciones ? `
            <div class="pedido-observaciones">
              <strong>Observaciones</strong>
              ${escapeHtml(pedido.observaciones)}
            </div>` : ""}

          ${total > 0 ? `
            <div class="pedido-total">
              <span>Total del pedido</span>
              <span class="pedido-total-val">${formatPrecio(total)}</span>
            </div>` : ""}

          ${acciones ? `<div class="pedido-actions">${acciones}</div>` : ""}

        </div>`;
    }

    // ── CAMBIAR ESTADO ────────────────────────────────────────────
    async function cambiarEstado(idPedido, nuevoEstado) {
      if (enCambioEstado.has(idPedido)) return;
      enCambioEstado.add(idPedido);

      const btn = document.getElementById(`btn-${idPedido}`);
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
      }

      try {
        // PATCH /pedidos/{id}/estado — requiere token de cocina
        // Body: { estado: "en_preparacion" | "listo" }
        await fetchAPI(`/pedidos/${idPedido}/estado`, "PATCH", { estado: nuevoEstado });

        const labels = {
          en_preparacion: "Pedido en preparación",
          listo:          "Pedido marcado como listo",
          confirmado:     "Pedido confirmado",
          entregado:      "Pedido entregado",
        };
        mostrarToast(labels[nuevoEstado] || "Estado actualizado", "success");

        // Recargar inmediatamente sin esperar el polling
        await cargarPedidos();

      } catch (error) {
        mostrarToast("Error al cambiar estado: " + error.message, "error");
        if (btn) {
          btn.disabled = false;
          const textos = {
            confirmado: "Confirmar",
            en_preparacion: " En preparación",
            listo: "Marcar listo",
            entregado: "Entregado",
          };
          btn.innerHTML = textos[nuevoEstado] || "Actualizar";
        }
      } finally {
        enCambioEstado.delete(idPedido);
      }
    }

    // ── TIEMPO REAL ──────────────────────────────────────────────
    function conectarTiempoReal() {
      const token = getToken();
      if (!token) return;

      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      const socket = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?token=${encodeURIComponent(token)}`);

      socket.addEventListener("message", (event) => {
        reproducirAviso();
        try {
          const data = JSON.parse(event.data);
          if (data.type === "servicio_mesa") {
            mostrarToast(data.message || "Nueva solicitud de mesa", "success");
            return;
          }
        } catch {
          // Si no llega JSON valido, se conserva el comportamiento anterior.
        }
        cargarPedidos();
      });

      socket.addEventListener("close", () => {
        setTimeout(conectarTiempoReal, 4000);
      });
    }

    function reproducirAviso() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 880;
        gain.gain.value = 0.04;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.16);
      } catch {
        // El navegador puede bloquear audio si no hubo interacción previa.
      }
    }

    // ── HELPERS ──────────────────────────────────────────────────
    function formatHora(fechaStr) {
      try {
        const d = new Date(fechaStr);
        return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      } catch { return "—"; }
    }

    function calcularTiempo(fechaStr) {
      try {
        const diff = Date.now() - new Date(fechaStr).getTime();
        return Math.floor(diff / 60000); // minutos
      } catch { return null; }
    }

    function calcularTotal(productos) {
      return productos.reduce((acc, p) =>
        acc + ((p.precio || p.subtotal || 0) * (p.cantidad || 1)), 0);
    }

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });

    function formatPrecio(valor) {
      return formatterPrecio.format(Number(valor) || 0);
    }

    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = mensaje;
      toast.className   = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  