
    // ── DEVICE TOKEN ─────────────────────────────────────────────
    // El panel de cocina no requiere login de usuario. Se protege con
    // COCINA_DEVICE_TOKEN (fijo por dispositivo, configurado en pedidos.html).
    const DEVICE_TOKEN = window.COCINA_DEVICE_TOKEN || "";

    // ── ESTADO ──────────────────────────────────────────────────
    let pedidos        = [];
    let pollingTimer   = null;
    let primeraVez     = true;

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
        // GET /pedidos/activos-completos — acepta device_token como alternativa a JWT
        const lista = await fetchAPI(`/pedidos/activos-completos?device_token=${encodeURIComponent(DEVICE_TOKEN)}`, "GET", null, false);
        const conDetalle = Array.isArray(lista) ? lista : [];

        // Mostrar todos los pedidos no entregados ni cancelados
        pedidos = conDetalle.filter(p => p.estado !== "entregado" && p.estado !== "cancelado");

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
      document.getElementById("count-total").textContent = pedidos.length;
    }

    // ── RENDER DE COLUMNAS ───────────────────────────────────────
    function renderColumnas() {
      document.getElementById("columnas").innerHTML = pedidos.length === 0
        ? `<div class="columna-empty" style="grid-column:1/-1">
             <div class="icon">—</div>
             <p>Sin pedidos activos</p>
           </div>`
        : pedidos.map(p => renderPedidoCard(p, p.estado === "listo" ? "verde" : "amarillo")).join("");
    }

    // ── RENDER DE CADA CARD DE PEDIDO ────────────────────────────
    function renderPedidoCard(pedido, color) {
      const hora      = pedido.fecha ? formatHora(pedido.fecha) : "—";
      const tiempo    = pedido.fecha ? calcularTiempo(pedido.fecha) : null;
      const productos = pedido.detalle || [];
      const grupos    = agruparDetallePedido(productos);
      const total     = pedido.total || calcularTotal(productos);

      // Clase de urgencia según tiempo transcurrido
      let tiempoClass = "ok";
      let tiempoLabel = "";
      if (tiempo !== null) {
        if (tiempo > 20)       { tiempoClass = "urgente"; tiempoLabel = ` ${tiempo}m`; }
        else if (tiempo > 10)  { tiempoClass = "normal";  tiempoLabel = `${tiempo}m`; }
        else                   { tiempoClass = "ok";      tiempoLabel = `${tiempo}m`; }
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
              ? `${renderGrupoPedido("Comida", grupos.comida, color, "comida")}
                 ${renderGrupoPedido("Bebidas", grupos.bebidas, color, "bebidas")}`
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

          <div class="pedido-actions">
            ${pedido.estado === "listo"
              ? `<div class="pedido-estado-listo">Listo — esperando al mozo</div>`
              : `<button class="btn-accion btn-listo" type="button" onclick="marcarListo(${pedido.id_pedido})">Marcar listo</button>`
            }
          </div>

        </div>`;
    }

    // ── MARCAR LISTO ─────────────────────────────────────────────
    async function marcarListo(idPedido) {
      const card = document.getElementById(`card-${idPedido}`);
      const btn  = card ? card.querySelector(".btn-listo") : null;
      if (btn) { btn.disabled = true; btn.textContent = "Marcando..."; }
      try {
        await fetchAPI(
          `/pedidos/${idPedido}/estado?device_token=${encodeURIComponent(DEVICE_TOKEN)}`,
          "PATCH",
          { estado: "listo" },
          false
        );
        mostrarToast(`Pedido #${idPedido} marcado como listo.`, "success");
        await cargarPedidos();
      } catch (error) {
        mostrarToast("No se pudo marcar el pedido: " + error.message, "error");
        if (btn) { btn.disabled = false; btn.textContent = "Marcar listo"; }
      }
    }

    function renderGrupoPedido(titulo, items, color, tipo) {
      if (!items.length) return "";
      return `
        <div class="pedido-grupo pedido-grupo-${tipo}">
          <div class="pedido-grupo-titulo">${titulo}</div>
          ${items.map(item => `
            <div class="pedido-item">
              <span class="pedido-item-nombre">
                ${escapeHtml(item.nombre || item.producto_nombre || "Producto")}
                ${item.subcategoria ? `<em>${escapeHtml(item.subcategoria)}</em>` : ""}
              </span>
              <span class="pedido-item-cantidad ${color}">×${item.cantidad}</span>
            </div>`).join("")}
        </div>`;
    }

    function agruparDetallePedido(detalle) {
      return detalle.reduce((acc, item) => {
        const destino = esBebida(item) ? "bebidas" : "comida";
        acc[destino].push(item);
        return acc;
      }, { bebidas: [], comida: [] });
    }

    function esBebida(item) {
      const texto = normalizarTexto([
        item.categoria,
        item.subcategoria,
        item.nombre,
      ].filter(Boolean).join(" "));
      return /bebida|bebidas|cerveza|cervezas|coctel|cocteleria|gin|tonic|whisky|champagne|gaseosa|agua|limonada|pomelada|naranjada|jugo|coca|sprite|tragos?|sin alcohol/.test(texto);
    }

    function normalizarTexto(texto) {
      return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    }

    // ── TIEMPO REAL ──────────────────────────────────────────────
    function conectarTiempoReal() {
      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      const socket = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?device_token=${encodeURIComponent(DEVICE_TOKEN)}`);

      socket.addEventListener("message", (event) => {
        let data = {};
        try {
          data = JSON.parse(event.data);
        } catch {
          data = {};  // JSON inválido: se conserva el comportamiento anterior.
        }

        if (data.type === "servicio_mesa") {
          reproducirAviso();
          mostrarToast(data.message || "Nueva solicitud de mesa", "success");
          return;
        }
        // Beep solo para pedidos nuevos; no para cambios de estado (un
        // "pedido_actualizado" puede haberlo disparado esta misma cocina al
        // tocar "Marcar listo" — sería un beep molesto sobre la propia acción).
        if (data.type !== "pedido_actualizado") reproducirAviso();
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
  
