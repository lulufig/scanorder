
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    if (!requireAuth(ROLES.ADMIN, ROLES.MOZO)) throw new Error();
    applyRoleVisibility();

    const usuario = getUser();
    if (usuario) {
      const nombreEl = document.getElementById("sidebar-username");
      if (nombreEl) nombreEl.textContent = usuario.nombre;
    }

    const METODO_LABEL = { efectivo: "Efectivo", tarjeta: "Tarjeta", qr: "QR", otro: "Otro" };

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency", currency: "ARS", maximumFractionDigits: 0,
    });
    const formatPrecio = v => formatterPrecio.format(Number(v) || 0);

    document.addEventListener("DOMContentLoaded", () => {
      const hoy = new Date().toISOString().split("T")[0];
      const input = document.getElementById("caja-fecha");
      if (input) {
        input.value = hoy;
        input.max = hoy;
      }
      cargarCaja();
    });

    async function cargarCaja() {
      const fecha = document.getElementById("caja-fecha")?.value;
      const params = fecha ? `?fecha=${fecha}` : "";
      try {
        const data = await fetchAPI(`/reportes/mi-caja${params}`);
        renderCaja(data);
      } catch (error) {
        mostrarToast("No se pudo cargar la caja: " + error.message, "error");
      }
    }

    function renderCaja(data) {
      const r = data.resumen || {};
      const cobros = Array.isArray(data.cobros) ? data.cobros : [];

      const nombre = (getUser() && getUser().nombre) || "vos";
      const esHoy = data.fecha === new Date().toISOString().split("T")[0];
      const sub = document.getElementById("caja-subtitle");
      if (sub) {
        sub.textContent = esHoy
          ? `Cobros de ${nombre} — hoy`
          : `Cobros de ${nombre} — ${data.fecha}`;
      }

      setTxt("st-mesas", r.mesas_cobradas ?? 0);
      setTxt("st-total", formatPrecio(r.total_cobrado));
      setTxt("st-propinas", formatPrecio(r.propinas));
      setTxt("st-rendir", formatPrecio(r.efectivo_a_rendir));

      // Desglose por método
      const metodos = r.por_metodo || {};
      const cont = document.getElementById("caja-metodos");
      const entradas = Object.entries(metodos).filter(([, v]) => v > 0);
      cont.innerHTML = entradas.length
        ? entradas
            .sort((a, b) => b[1] - a[1])
            .map(([m, v]) => `
              <div class="caja-metodo-row">
                <span>${METODO_LABEL[m] || m}</span>
                <strong>${formatPrecio(v)}</strong>
              </div>`).join("")
        : `<div class="caja-vacio">Sin cobros para mostrar.</div>`;

      // Lista de cobros
      const count = document.getElementById("caja-cobros-count");
      if (count) count.textContent = `${cobros.length} ${cobros.length === 1 ? "cobro" : "cobros"}`;

      const wrap = document.getElementById("caja-cobros");
      if (!cobros.length) {
        wrap.innerHTML = `<div class="caja-vacio">Todavía no cobraste ninguna mesa ${esHoy ? "hoy" : "ese día"}.</div>`;
        return;
      }
      wrap.innerHTML = `
        <div class="caja-cobros-scroll">
          <table class="caja-tabla">
            <thead>
              <tr>
                <th>Hora</th><th>Mesa</th><th>Método</th>
                <th class="num">Total</th><th class="num">Propina</th><th class="num">Vuelto</th>
              </tr>
            </thead>
            <tbody>
              ${cobros.map(c => `
                <tr>
                  <td>${escapeHtml(c.hora || "—")}</td>
                  <td>${c.numero_mesa != null ? "Mesa " + c.numero_mesa : "—"}</td>
                  <td><span class="caja-metodo-tag metodo-${c.metodo_pago}">${METODO_LABEL[c.metodo_pago] || c.metodo_pago}</span></td>
                  <td class="num">${formatPrecio(c.total)}</td>
                  <td class="num">${c.propina ? formatPrecio(c.propina) : "—"}</td>
                  <td class="num">${c.vuelto ? formatPrecio(c.vuelto) : "—"}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <p class="caja-nota">"Efectivo a rendir" = ventas en efectivo + propinas en efectivo. Las propinas cobradas con tarjeta/QR se suman al total de propinas pero no las tenés en mano.</p>`;
    }

    function setTxt(id, valor) {
      const el = document.getElementById(id);
      if (el) el.textContent = valor;
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
