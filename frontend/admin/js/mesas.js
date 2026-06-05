
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    requireAuth(ROLES.ADMIN);

    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
    }

    // ── ESTADO LOCAL ────────────────────────────────────────────
    let todasLasMesas   = [];
    let mapaMesas       = [];
    let mesaQRActual    = null;  // mesa abierta en el modal
    let mesaOperacionActual = null;
    let mapaTimer       = null;
    let mapaSignature   = "";
    let mapaCardSignatures = new Map();
    let socketMesas     = null;

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
      cargarMesas();
      conectarTiempoRealMesas();
      mapaTimer = setInterval(cargarMapaMesas, 2500);
    });

    // Permitir crear con Enter
    document.getElementById("input-numero").addEventListener("keydown", e => {
      if (e.key === "Enter") crearMesa();
    });

    // ── CARGAR MESAS ────────────────────────────────────────────
    async function cargarMesas() {
      try {
        // GET /mesas — requiere token
        const data = await fetchAPI("/mesas");
        todasLasMesas = Array.isArray(data) ? data : [];
        actualizarStats(todasLasMesas);
        renderMesas(todasLasMesas);
        await cargarMapaMesas();
      } catch (error) {
        document.getElementById("mesas-grid-container").innerHTML = `
          <div class="mesas-grid">
            <div class="empty-state">
              <div class="icon">️</div>
              <p>No se pudo cargar las mesas: ${escapeHtml(error.message)}</p>
            </div>
          </div>`;
        document.getElementById("mesas-count-label").textContent = "Error al cargar";
      }
    }

    async function cargarMapaMesas() {
      try {
        const data = await fetchAPI("/mesas/mapa");
        mapaMesas = Array.isArray(data) ? data : [];
        renderMapaSalon(mapaMesas);
      } catch (error) {
        const floor = document.getElementById("salon-floor");
        if (floor) {
          floor.innerHTML = `
            <div class="empty-state">
              <div class="icon">Mapa</div>
              <p>No se pudo cargar el mapa: ${escapeHtml(error.message)}</p>
            </div>`;
        }
      }
    }

    // ── STATS ───────────────────────────────────────────────────
    function actualizarStats(mesas) {
      document.getElementById("stat-total").textContent = mesas.length;
      if (mesas.length > 0) {
        const ultima = mesas[mesas.length - 1];
        document.getElementById("stat-ultima").textContent = `Mesa ${ultima.numero}`;
      } else {
        document.getElementById("stat-ultima").textContent = "—";
      }
    }

    function renderMapaSalon(mesas) {
      const floor = document.getElementById("salon-floor");
      const updated = document.getElementById("salon-updated");
      const summary = document.getElementById("salon-summary");
      if (!floor) return;

      if (updated) {
        updated.textContent = `Actualizado ${new Date().toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit"
        })}`;
      }

      if (!mesas.length) {
        floor.innerHTML = `
          <div class="empty-state">
            <div class="icon">Mapa</div>
            <p>No hay mesas activas para mostrar.</p>
          </div>`;
        if (summary) summary.innerHTML = renderSalonSummary(0, 0, 0);
        return;
      }

      const activas = mesas.filter(m => m.estado_salon !== "libre").length;
      const esperando = mesas.filter(m => m.estado_salon === "esperando" || m.estado_salon === "pedido_activo" || m.estado_salon === "cuenta").length;
      const alertas = mesas.filter(m => m.estado_salon === "abandonada" || m.estado_salon === "esperando" || m.cuenta_solicitada || m.mozo_solicitado).length;
      if (summary) summary.innerHTML = renderSalonSummary(activas, esperando, alertas);

      const mesasOrdenadas = [...mesas].sort((a, b) => a.numero - b.numero);
      const maxPedidosHoy = Math.max(1, ...mesasOrdenadas.map(m => Number(m.pedidos_hoy) || 0));
      const layoutSignature = JSON.stringify(mesasOrdenadas.map(m => m.id_mesa));
      const tables = floor.querySelector(".salon-tables");

      if (layoutSignature === mapaSignature && tables) {
        mesasOrdenadas.forEach((mesa, index) => {
          const cardSignature = getMesaPlanoSignature(mesa, maxPedidosHoy);
          const currentSignature = mapaCardSignatures.get(mesa.id_mesa);
          if (cardSignature === currentSignature) return;

          const current = tables.querySelector(`[data-mesa-id="${mesa.id_mesa}"]`);
          const html = renderMesaPlano(mesa, index, maxPedidosHoy);
          if (current) {
            current.outerHTML = html;
          } else {
            tables.insertAdjacentHTML("beforeend", html);
          }
          mapaCardSignatures.set(mesa.id_mesa, cardSignature);
        });
        return;
      }

      mapaSignature = layoutSignature;
      mapaCardSignatures = new Map(mesasOrdenadas.map(mesa => [
        mesa.id_mesa,
        getMesaPlanoSignature(mesa, maxPedidosHoy),
      ]));

      floor.innerHTML = `
        <div class="salon-zone salon-zone-bar">Barra</div>
        <div class="salon-zone salon-zone-kitchen">Cocina</div>
        <div class="salon-zone salon-zone-entry">Entrada</div>
        <div class="salon-tables">
          ${mesasOrdenadas.map((mesa, index) => renderMesaPlano(mesa, index, maxPedidosHoy)).join("")}
        </div>`;
    }

    function getMesaPlanoSignature(mesa, maxPedidosHoy) {
      return JSON.stringify([
        mesa.id_mesa,
        mesa.numero,
        mesa.estado_salon,
        mesa.pedidos_activos,
        mesa.pendientes,
        mesa.confirmados,
        mesa.en_preparacion,
        mesa.listos,
        mesa.items_carrito,
        mesa.participantes,
        mesa.cuenta_solicitada,
        mesa.mozo_solicitado,
        mesa.minutos_espera,
        mesa.minutos_desde_scan,
        mesa.pedidos_hoy,
        maxPedidosHoy,
      ]);
    }

    function renderSalonSummary(activas, esperando, alertas) {
      return `
        <div class="salon-summary-item">
          <span>Activas</span>
          <strong>${activas}</strong>
        </div>
        <div class="salon-summary-item">
          <span>Esperando</span>
          <strong>${esperando}</strong>
        </div>
        <div class="salon-summary-item ${alertas > 0 ? "alert" : ""}">
          <span>Alertas</span>
          <strong>${alertas}</strong>
        </div>`;
    }

    function renderMesaPlano(mesa, index, maxPedidosHoy) {
      const estado = mesa.estado_salon || "libre";
      const heat = Math.min(1, (Number(mesa.pedidos_hoy) || 0) / maxPedidosHoy);
      const espera = mesa.minutos_espera != null ? `${mesa.minutos_espera} min` : "Sin espera";
      const participantes = Number(mesa.participantes) || 0;
      const carrito = Number(mesa.items_carrito) || 0;
      const pedidos = Number(mesa.pedidos_activos) || 0;
      const actividad = Number(mesa.pedidos_hoy) || 0;
      const estadoLabel = getEstadoMesaLabel(estado);
      const pedidoResumen = mesa.pendientes > 0
        ? `${mesa.pendientes} pendiente${mesa.pendientes === 1 ? "" : "s"}`
        : mesa.cuenta_solicitada
          ? "Cuenta solicitada"
          : `${pedidos} pedidos activos`;
      const alerta = estado === "abandonada"
        ? `<div class="mesa-alerta">Sin pedido hace ${mesa.minutos_desde_scan || 10} min</div>`
        : estado === "esperando"
          ? `<div class="mesa-alerta">Espera alta</div>`
          : mesa.cuenta_solicitada
            ? `<div class="mesa-alerta">Solicitó la cuenta</div>`
            : mesa.mozo_solicitado
              ? `<div class="mesa-alerta">Solicitó mozo</div>`
          : "";

      return `
        <button
          class="mesa-plano mesa-${estado}"
          data-mesa-id="${mesa.id_mesa}"
          style="--i:${index}; --heat:${heat.toFixed(2)}"
          type="button"
          onclick="abrirMesaOperacion(${mesa.id_mesa})"
          title="Mesa ${mesa.numero} — ${estadoLabel}"
        >
          <span class="mesa-heat"></span>
          <span class="mesa-top">
            <span class="mesa-status-dot"></span>
            <span class="mesa-status">${estadoLabel}</span>
          </span>
          <strong>Mesa ${escapeHtml(String(mesa.numero))}</strong>
          <span class="mesa-plano-meta">
            <span>${pedidoResumen}</span>
            <span>${carrito} items en carrito</span>
            <span>${participantes} personas</span>
          </span>
          <span class="mesa-plano-foot">
            <span>${espera}</span>
            <span>${actividad} hoy</span>
          </span>
          ${alerta}
        </button>`;
    }

    function getEstadoMesaLabel(estado) {
      const labels = {
        libre: "Libre",
        ocupada: "Ocupada",
        pidiendo: "Pidiendo",
        pedido_activo: "Ocupada",
        esperando: "Espera alta",
        cuenta: "Cuenta",
        abandonada: "Abandonada",
      };
      return labels[estado] || "Libre";
    }

    async function abrirMesaOperacion(idMesa) {
      mesaOperacionActual = idMesa;
      const overlay = document.getElementById("mesa-operacion-overlay");
      const body = document.getElementById("mesa-operacion-body");
      const title = document.getElementById("mesa-operacion-title");
      if (!overlay || !body || !title) return;

      overlay.classList.add("open");
      title.textContent = "Mesa";
      body.innerHTML = `
        <div class="empty-state">
          <div class="icon">Mesa</div>
          <p>Cargando detalle...</p>
        </div>`;

      try {
        const data = await fetchAPI(`/mesas/${idMesa}/operacion`);
        renderMesaOperacion(data);
      } catch (error) {
        body.innerHTML = `
          <div class="empty-state">
            <div class="icon">Error</div>
            <p>No se pudo cargar la mesa: ${escapeHtml(error.message)}</p>
          </div>`;
      }
    }

    function renderMesaOperacion(data) {
      const body = document.getElementById("mesa-operacion-body");
      const title = document.getElementById("mesa-operacion-title");
      const mesa = data.mesa || {};
      const pedidos = Array.isArray(data.pedidos) ? data.pedidos : [];
      title.textContent = `Mesa ${mesa.numero || "—"}`;

      body.innerHTML = `
        <div class="mesa-operacion-summary">
          <div>
            <span>Estado</span>
            <strong>${data.cuenta_solicitada ? "Cuenta solicitada" : data.mozo_solicitado ? "Mozo solicitado" : data.ocupada ? "Ocupada" : "Sin actividad"}</strong>
          </div>
          <div>
            <span>Pedidos del día</span>
            <strong>${pedidos.length}</strong>
          </div>
        </div>
        <div class="mesa-operacion-actions">
          ${data.mozo_solicitado
            ? `<button class="btn-ghost btn-service-done" type="button" onclick="atenderMozo(${mesa.id_mesa})">Mozo atendido</button>`
            : ""
          }
          <button class="btn-ghost" type="button" onclick="liberarMesa(${mesa.id_mesa})">Marcar cobrada y liberar</button>
        </div>
        <div class="mesa-pedidos-list">
          ${pedidos.length
            ? pedidos.map(renderPedidoMesa).join("")
            : `<div class="empty-state mesa-empty"><p>Esta mesa no tiene pedidos activos del día.</p></div>`
          }
        </div>`;
    }

    function renderPedidoMesa(pedido) {
      const detalle = Array.isArray(pedido.detalle) ? pedido.detalle : [];
      const observaciones = (pedido.observaciones || "").trim();
      const accion = pedido.estado === "pendiente"
        ? `<button class="btn-primary mesa-action-primary" type="button" onclick="avanzarPedidoMesa(${pedido.id_pedido}, 'confirmado')">Confirmar pedido</button>`
        : pedido.estado === "listo"
          ? `<button class="btn-primary mesa-action-primary" type="button" onclick="avanzarPedidoMesa(${pedido.id_pedido}, 'entregado')">Entregar pedido</button>`
          : "";
      const estadoClase = String(pedido.estado || "").replace(/_/g, "-");

      return `
        <article class="mesa-pedido-card estado-${estadoClase}">
          <button class="mesa-pedido-head" type="button" onclick="togglePedidoMesa(${pedido.id_pedido})">
            <div>
              <strong class="mesa-pedido-number">Pedido #${pedido.id_pedido}</strong>
              <span>
                <b>${escapeHtml(labelEstadoPedido(pedido.estado))}</b>
                · ${pedido.minutos_espera ?? 0} min
                ${observaciones ? " · Con observaciones" : ""}
              </span>
            </div>
            <div class="mesa-pedido-total">${formatPrecio(pedido.total)}</div>
          </button>
          <div class="mesa-pedido-detail" id="pedido-detalle-${pedido.id_pedido}">
            ${observaciones
              ? `<div class="mesa-pedido-observaciones">
                  <span>Observaciones</span>
                  <p>${escapeHtml(observaciones)}</p>
                </div>`
              : ""
            }
            <div class="mesa-pedido-items">
            ${detalle.map(item => `
              <div>
                <span>${escapeHtml(item.nombre)} x${item.cantidad}</span>
                <strong>${formatPrecio(item.subtotal)}</strong>
              </div>
            `).join("")}
            </div>
            ${accion ? `<div class="mesa-pedido-actions">${accion}</div>` : ""}
          </div>
        </article>`;
    }

    function togglePedidoMesa(idPedido) {
      const detail = document.getElementById(`pedido-detalle-${idPedido}`);
      if (!detail) return;
      detail.classList.toggle("open");
    }

    async function avanzarPedidoMesa(idPedido, estado) {
      try {
        await fetchAPI(`/pedidos/${idPedido}/estado`, "PATCH", { estado });
        mostrarToast("Pedido actualizado.", "success");
        await cargarMapaMesas();
        if (mesaOperacionActual) await abrirMesaOperacion(mesaOperacionActual);
      } catch (error) {
        mostrarToast("No se pudo actualizar el pedido: " + error.message, "error");
      }
    }

    async function liberarMesa(idMesa) {
      try {
        await fetchAPI(`/mesas/${idMesa}/liberar`, "POST");
        document.querySelectorAll(".mesa-pedido-card").forEach(card => {
          card.classList.add("mesa-pedido-cobrada");
        });
        mostrarToast("Mesa marcada como cobrada y libre.", "success");
        await cargarMapaMesas();
      } catch (error) {
        mostrarToast("No se pudo liberar la mesa: " + error.message, "error");
      }
    }

    async function atenderMozo(idMesa) {
      try {
        await fetchAPI(`/mesas/${idMesa}/atender-mozo`, "POST");
        mostrarToast("Solicitud de mozo marcada como atendida.", "success");
        await cargarMapaMesas();
        if (mesaOperacionActual) await abrirMesaOperacion(mesaOperacionActual);
      } catch (error) {
        mostrarToast("No se pudo marcar la solicitud: " + error.message, "error");
      }
    }

    function cerrarMesaOperacion() {
      document.getElementById("mesa-operacion-overlay").classList.remove("open");
      mesaOperacionActual = null;
    }

    function cerrarMesaOperacionSiAfuera(event) {
      if (event.target === document.getElementById("mesa-operacion-overlay")) cerrarMesaOperacion();
    }

    function labelEstadoPedido(estado) {
      const labels = {
        pendiente: "Pendiente",
        confirmado: "Confirmado",
        en_preparacion: "En preparación",
        listo: "Listo",
        entregado: "Entregado",
      };
      return labels[estado] || estado;
    }

    // ── RENDER GRID ─────────────────────────────────────────────
    function renderMesas(mesas) {
      const container = document.getElementById("mesas-grid-container");
      const label     = document.getElementById("mesas-count-label");

      label.textContent = mesas.length === 1 ? "1 mesa" : `${mesas.length} mesas`;

      if (mesas.length === 0) {
        container.innerHTML = `
          <div class="mesas-grid">
            <div class="empty-state">
              <div class="icon">Mesa</div>
              <p>No hay mesas todavía.<br>¡Creá la primera!</p>
            </div>
          </div>`;
        return;
      }

      const cards = mesas.map((mesa, i) => {
        // La URL del QR la arma el backend como: /mesas/{id}/qr
        const qrEndpoint = `/mesas/${mesa.id_mesa}/qr`;
        const qrSrc      = `${API_URL}${qrEndpoint}?v=${Date.now()}`;

        return `
          <div class="mesa-card" style="animation-delay: ${i * 0.05}s">
            <div class="mesa-numero-label">Mesa</div>
            <div class="mesa-numero">${escapeHtml(String(mesa.numero))}</div>
            ${mesa.qr_url
              ? `<img
                   src="${escapeHtml(qrSrc)}"
                   class="mesa-qr-preview"
                   alt="QR Mesa ${mesa.numero}"
                   onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
                 <div class="mesa-qr-placeholder" style="display:none;">QR</div>`
              : `<div class="mesa-qr-placeholder">QR</div>`
            }
            <div class="mesa-actions">
              <button class="btn-ver-qr" onclick="verQR(${mesa.id_mesa}, ${mesa.numero}, '${escapeHtml(qrSrc)}')">
                Ver QR
              </button>
              <button class="btn-dl-qr" onclick="descargarQR('${escapeHtml(qrEndpoint)}', ${mesa.numero})">
                Descargar
              </button>
            </div>
          </div>`;
      }).join("");

      container.innerHTML = `<div class="mesas-grid">${cards}</div>`;
    }

    // ── CREAR MESA ──────────────────────────────────────────────
    async function crearMesa() {
      const numero = parseInt(document.getElementById("input-numero").value);

      if (!numero || numero < 1) {
        mostrarToast("Ingresá un número de mesa válido.", "error");
        return;
      }

      // Verificar si el número ya existe
      const yaExiste = todasLasMesas.some(m => m.numero === numero);
      if (yaExiste) {
        mostrarToast(`La mesa ${numero} ya existe.`, "error");
        return;
      }

      const btn = document.getElementById("btn-crear");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Creando...';

      try {
        // POST /mesas — body: { numero }
        // El backend genera el QR automáticamente
        await fetchAPI("/mesas", "POST", { numero });
        mostrarToast(`Mesa ${numero} creada con QR generado.`, "success");
        document.getElementById("input-numero").value = "";
        await cargarMesas(); // recarga el grid
      } catch (error) {
        mostrarToast("Error al crear mesa: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = "Crear mesa";
      }
    }

    // ── VER QR EN MODAL ─────────────────────────────────────────
    function verQR(idMesa, numero, qrSrc) {
      mesaQRActual = { idMesa, numero, qrSrc };

      document.getElementById("modal-qr-title").textContent = `QR — Mesa ${numero}`;
      document.getElementById("modal-qr-img").src            = qrSrc;
      document.getElementById("modal-qr-url").textContent    =
        `${API_URL}/mesas/${idMesa}/qr`;

      document.getElementById("modal-overlay").classList.add("open");
    }

    // ── DESCARGAR QR DESDE MODAL ────────────────────────────────
    async function descargarQRModal() {
      if (!mesaQRActual) return;
      await descargarQR(`/mesas/${mesaQRActual.idMesa}/qr`, mesaQRActual.numero);
    }

    // ── DESCARGAR QR DIRECTO DESDE CARD ─────────────────────────
    async function descargarQR(endpoint, numero) {
      try {
        // Usa downloadFile() de api.js que maneja el Bearer token
        await downloadFile(endpoint, `mesa_${numero}_qr.png`);
        mostrarToast(`QR de mesa ${numero} descargado.`, "success");
      } catch (error) {
        mostrarToast("Error al descargar el QR: " + error.message, "error");
      }
    }

    // ── HELPERS MODAL ───────────────────────────────────────────
    function cerrarModal() {
      document.getElementById("modal-overlay").classList.remove("open");
      mesaQRActual = null;
    }

    function cerrarModalSiAfuera(event) {
      if (event.target === document.getElementById("modal-overlay")) cerrarModal();
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        cerrarModal();
        cerrarMesaOperacion();
      }
    });

    window.addEventListener("beforeunload", () => {
      if (mapaTimer) clearInterval(mapaTimer);
    });

    // ── TOAST ───────────────────────────────────────────────────
    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = mensaje;
      toast.className   = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }

    // ── ESCAPE HTML ─────────────────────────────────────────────
    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function conectarTiempoRealMesas() {
      const token = getToken();
      if (!token) return;

      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      socketMesas = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?token=${encodeURIComponent(token)}`);

      socketMesas.addEventListener("message", (event) => {
        reproducirAviso();
        let data = {};
        try {
          data = JSON.parse(event.data);
        } catch {
          data = {};
        }

        if (data.type === "pedido_creado") {
          mostrarToast(data.message || "Nueva mesa envió un pedido.", "success");
        } else if (data.type === "servicio_mesa") {
          mostrarToast(data.message || "Nueva solicitud de mesa", "success");
        } else if (data.type === "pedido_actualizado") {
          mostrarToast("Pedido actualizado en cocina.", "success");
        }

        cargarMapaMesas();
        if (mesaOperacionActual) abrirMesaOperacion(mesaOperacionActual);
      });

      socketMesas.addEventListener("close", () => {
        setTimeout(conectarTiempoRealMesas, 4000);
      });
    }

    function reproducirAviso() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 740;
        gain.gain.value = 0.035;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.14);
      } catch {
        // El navegador puede bloquear audio si no hubo interacción.
      }
    }

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });

    function formatPrecio(valor) {
      return formatterPrecio.format(Number(valor) || 0);
    }
  
