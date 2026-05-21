
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    requireAuth(ROLES.ADMIN);

    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
    }

    // ── ESTADO LOCAL ────────────────────────────────────────────
    let todasLasMesas   = [];
    let mesaQRActual    = null;  // mesa abierta en el modal

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", cargarMesas);

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
        btn.innerHTML = "+ Crear mesa";
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
      if (e.key === "Escape") cerrarModal();
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
  
