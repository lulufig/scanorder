
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    if (!requireAuth(ROLES.ADMIN, ROLES.MOZO)) throw new Error();
    applyRoleVisibility();

    const usuario = getUser();
    if (usuario) {
      const nombreEl = document.getElementById("sidebar-username");
      if (nombreEl) nombreEl.textContent = usuario.nombre;
    }
    const ES_ADMIN = getUserRole() === ROLES.ADMIN;

    const METODO_LABEL = { efectivo: "Efectivo", tarjeta: "Tarjeta", qr: "QR", otro: "Otro" };

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency", currency: "ARS", maximumFractionDigits: 0,
    });
    const formatPrecio = v => formatterPrecio.format(Number(v) || 0);

    // Fecha LOCAL en YYYY-MM-DD. No usar toISOString() (da la fecha UTC: de noche
    // en Argentina ya es "mañana" y el backend filtra por DATE(created_at) local).
    function hoyLocalISO() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function initCaja() {
      const hoy = hoyLocalISO();
      const input = document.getElementById("caja-fecha");
      if (input) { input.value = hoy; input.max = hoy; }
      const title = document.getElementById("caja-title");
      if (title) title.textContent = ES_ADMIN ? "Caja" : "Mi caja";
      cargarCaja();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initCaja);
    } else {
      initCaja();
    }

    async function cargarCaja() {
      const cont = document.getElementById("caja-contenido");
      const fecha = document.getElementById("caja-fecha")?.value;
      const params = fecha ? `?fecha=${fecha}` : "";
      try {
        if (ES_ADMIN) {
          renderResumen(await fetchAPI(`/caja/resumen${params}`));
        } else {
          renderMia(await fetchAPI(`/caja/mia${params}`));
        }
      } catch (error) {
        if (cont) {
          cont.innerHTML = `<div class="caja-vacio">No se pudo cargar la caja: ${escapeHtml(error.message)}<br><small>Probá recargar con Ctrl+F5.</small></div>`;
        }
        mostrarToast("No se pudo cargar la caja: " + error.message, "error");
      }
    }

    function esHoySeleccionado(fecha) {
      return fecha === hoyLocalISO();
    }

    // ── VISTA DEL MOZO: mis cobros + rendición ─────────────────
    function renderMia(data) {
      const r = data.resumen || {};
      const cobros = Array.isArray(data.cobros) ? data.cobros : [];
      const nombre = (getUser() && getUser().nombre) || "vos";
      const hoy = esHoySeleccionado(data.fecha);
      document.getElementById("caja-subtitle").textContent =
        hoy ? `Cobros de ${nombre} — hoy` : `Cobros de ${nombre} — ${data.fecha}`;

      const pendiente = r.efectivo_pendiente || 0;
      const cont = document.getElementById("caja-contenido");
      if (!cont) return;
      cont.innerHTML = `
        <div class="caja-stats">
          <div class="caja-stat">
            <span class="caja-stat-label">Mesas cobradas</span>
            <strong class="caja-stat-value">${r.mesas_cobradas ?? 0}</strong>
          </div>
          <div class="caja-stat">
            <span class="caja-stat-label">Total cobrado</span>
            <strong class="caja-stat-value">${formatPrecio(r.total_cobrado)}</strong>
          </div>
          <div class="caja-stat">
            <span class="caja-stat-label">Propinas (tuyas)</span>
            <strong class="caja-stat-value">${formatPrecio(r.propinas)}</strong>
          </div>
          <div class="caja-stat ${pendiente > 0 ? "caja-stat-alerta" : "caja-stat-destacado"}">
            <span class="caja-stat-label">Efectivo pendiente de rendir</span>
            <strong class="caja-stat-value">${formatPrecio(pendiente)}</strong>
            <span class="caja-stat-sub">de ${formatPrecio(r.efectivo_a_rendir)} · rendido ${formatPrecio(r.efectivo_rendido)}</span>
          </div>
        </div>

        <div class="card caja-card">
          <div class="card-header"><div><div class="card-title">Mis cobros del día</div>
            <div class="card-subtitle">${cobros.length} ${cobros.length === 1 ? "cobro" : "cobros"}</div></div></div>
          <div class="caja-cobros-wrap">
            ${cobros.length ? `
              <div class="caja-cobros-scroll">
                <table class="caja-tabla">
                  <thead><tr>
                    <th>Hora</th><th>Mesa</th><th>Método</th>
                    <th class="num">Total</th><th class="num">Propina</th><th>Efectivo a caja</th>
                  </tr></thead>
                  <tbody>
                    ${cobros.map(c => `
                      <tr>
                        <td>${escapeHtml(c.hora || "—")}</td>
                        <td>${c.numero_mesa != null ? "Mesa " + c.numero_mesa : "—"}</td>
                        <td><span class="caja-metodo-tag metodo-${c.metodo_pago}">${METODO_LABEL[c.metodo_pago] || c.metodo_pago}</span></td>
                        <td class="num">${formatPrecio(c.total)}</td>
                        <td class="num">${c.propina ? formatPrecio(c.propina) : "—"}</td>
                        <td>${renderRendirCell(c)}</td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </div>
              <p class="caja-nota">"Entregado a caja" marca que ya llevaste ese efectivo. Las propinas van aparte y son tuyas — no se rinden.</p>
            ` : `<div class="caja-vacio">Todavía no cobraste ninguna mesa ${hoy ? "hoy" : "ese día"}.</div>`}
          </div>
        </div>`;
      if (window.lucide) lucide.createIcons();
    }

    function renderRendirCell(c) {
      if (c.metodo_pago !== "efectivo") return `<span class="caja-na">—</span>`;
      return c.rendido
        ? `<button class="caja-btn-rendido" type="button" onclick="rendirCobro(${c.id_cierre}, false)">✓ Entregado</button>`
        : `<button class="caja-btn-rendir" type="button" onclick="rendirCobro(${c.id_cierre}, true)">Entregar a caja</button>`;
    }

    async function rendirCobro(idCierre, rendido) {
      try {
        await fetchAPI(`/caja/cobros/${idCierre}/rendir`, "POST", { rendido });
        mostrarToast(rendido ? "Efectivo marcado como entregado." : "Marca quitada.", "success");
        cargarCaja();
      } catch (error) {
        mostrarToast("No se pudo actualizar: " + error.message, "error");
      }
    }

    // ── VISTA DEL ADMIN: consolidado del día ───────────────────
    function renderResumen(data) {
      const t = data.totales || {};
      const mozos = Array.isArray(data.por_mozo) ? data.por_mozo : [];
      const hoy = esHoySeleccionado(data.fecha);
      document.getElementById("caja-subtitle").textContent =
        hoy ? "Toda la caja — hoy" : `Toda la caja — ${data.fecha}`;

      const pendienteTotal = mozos.reduce((s, m) => s + (m.efectivo_pendiente || 0), 0);
      const cont = document.getElementById("caja-contenido");
      if (!cont) return;
      cont.innerHTML = `
        <div class="caja-stats">
          <div class="caja-stat"><span class="caja-stat-label">Efectivo</span><strong class="caja-stat-value">${formatPrecio(t.efectivo)}</strong></div>
          <div class="caja-stat"><span class="caja-stat-label">Tarjeta</span><strong class="caja-stat-value">${formatPrecio(t.tarjeta)}</strong></div>
          <div class="caja-stat"><span class="caja-stat-label">QR</span><strong class="caja-stat-value">${formatPrecio(t.qr)}</strong></div>
          <div class="caja-stat caja-stat-destacado"><span class="caja-stat-label">Total del día</span><strong class="caja-stat-value">${formatPrecio(t.total)}</strong></div>
        </div>

        <div class="card caja-card">
          <div class="card-header"><div>
            <div class="card-title">Efectivo por mozo</div>
            <div class="card-subtitle">${pendienteTotal > 0 ? `Pendiente de rendir: ${formatPrecio(pendienteTotal)}` : "Todo rendido"}</div>
          </div></div>
          <div class="caja-cobros-wrap">
            ${mozos.length ? `
              <div class="caja-cobros-scroll">
                <table class="caja-tabla">
                  <thead><tr>
                    <th>Mozo</th><th class="num">Cobros</th>
                    <th class="num">Efectivo cobrado</th><th class="num">Rendido</th>
                    <th class="num">Pendiente</th><th class="num">Otros métodos</th>
                  </tr></thead>
                  <tbody>
                    ${mozos.map(m => `
                      <tr>
                        <td>${escapeHtml(m.nombre)}${m.rol === "admin" ? ' <span class="mozo-tag">admin</span>' : ""}</td>
                        <td class="num">${m.cobros}</td>
                        <td class="num">${formatPrecio(m.efectivo_cobrado)}</td>
                        <td class="num">${formatPrecio(m.efectivo_rendido)}</td>
                        <td class="num ${m.efectivo_pendiente > 0 ? "caja-pendiente" : ""}">${m.efectivo_pendiente > 0 ? formatPrecio(m.efectivo_pendiente) : "—"}</td>
                        <td class="num">${m.otros_metodos ? formatPrecio(m.otros_metodos) : "—"}</td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </div>
              <p class="caja-nota">"Pendiente" = efectivo que el mozo cobró y todavía no marcó como entregado a caja. Tarjeta y QR van directo a la cuenta del local.</p>
            ` : `<div class="caja-vacio">Sin cobros registrados ${hoy ? "hoy" : "ese día"}.</div>`}
          </div>
        </div>`;
      if (window.lucide) lucide.createIcons();
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      if (!toast) return;
      toast.textContent = mensaje;
      toast.className = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }
