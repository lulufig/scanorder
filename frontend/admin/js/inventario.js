
  requireAuth(ROLES.ADMIN);
  applyRoleVisibility();

  // Mostrar nombre del usuario en sidebar
  const nombre = getUserNombre();
  if (nombre) document.getElementById("sidebar-username").textContent = nombre;

  // ── Estado ───────────────────────────────────────────────────────────────
  let inventario = [];

  // ── Carga inicial ────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    cargarInventario();
    setInterval(cargarInventario, 30000);
  });

  async function cargarInventario() {
    try {
      inventario = await fetchAPI("/inventario/", "GET");
      actualizarAlerta();
      renderTabla();
    } catch (err) {
      document.getElementById("inv-tbody").innerHTML =
        `<tr><td colspan="6" style="text-align:center;padding:2rem;color:#f87171">
           Error al cargar inventario: ${escapeHtml(err.message)}
         </td></tr>`;
    }
  }

  // ── Alerta global de stock bajo ──────────────────────────────────────────
  function actualizarAlerta() {
    const bajos = inventario.filter(p => p.estado !== "OK").length;
    const banner = document.getElementById("alerta-bajo-minimo");
    if (bajos > 0) {
      document.getElementById("alerta-count").textContent = bajos;
      banner.classList.add("visible");
    } else {
      banner.classList.remove("visible");
    }
  }

  // ── Render de tabla ──────────────────────────────────────────────────────
  function renderTabla() {
    const filtroEstado = document.getElementById("filtro-estado").value;
    const filtroNombre = document.getElementById("filtro-nombre").value.trim().toLowerCase();

    const filtrado = inventario.filter(p => {
      const pasaEstado = !filtroEstado || p.estado === filtroEstado;
      const pasaNombre = !filtroNombre || p.nombre.toLowerCase().includes(filtroNombre);
      return pasaEstado && pasaNombre;
    });

    const tbody = document.getElementById("inv-tbody");

    if (filtrado.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:#888">Sin resultados</td></tr>`;
      return;
    }

    tbody.innerHTML = filtrado.map(p => `
      <tr>
        <td>${escapeHtml(p.nombre)}</td>
        <td>${escapeHtml(p.categoria || "—")}</td>
        <td class="stock-num">${p.stock_actual}</td>
        <td class="stock-num">${p.stock_minimo}</td>
        <td>${badgeEstado(p.estado)}</td>
        <td>
          <button class="btn-ajustar"
            onclick="abrirModal(${p.id_producto}, '${escapeHtml(p.nombre).replace(/'/g, "\\'")}', ${p.stock_actual}, ${p.stock_minimo})">
            Ajustar
          </button>
        </td>
      </tr>
    `).join("");
  }

  function badgeEstado(estado) {
    const map = {
      OK:      '<span class="badge badge-ok">OK</span>',
      BAJO:    '<span class="badge badge-bajo">BAJO</span>',
      AGOTADO: '<span class="badge badge-agotado">AGOTADO</span>',
    };
    return map[estado] || estado;
  }

  // ── Modal de ajuste ──────────────────────────────────────────────────────
  function abrirModal(idProd, nombre, stockActual, stockMinimo) {
    document.getElementById("modal-id-prod").value    = idProd;
    document.getElementById("modal-nombre-prod").textContent = nombre;
    document.getElementById("modal-stock-actual").value  = stockActual;
    document.getElementById("modal-stock-minimo").value  = stockMinimo;
    document.getElementById("modal-motivo").value         = "";
    document.getElementById("modal-ajuste").classList.add("open");
  }

  function cerrarModal() {
    document.getElementById("modal-ajuste").classList.remove("open");
  }

  async function guardarAjuste() {
    const idProd      = parseInt(document.getElementById("modal-id-prod").value);
    const stockActual = parseInt(document.getElementById("modal-stock-actual").value);
    const stockMinimo = parseInt(document.getElementById("modal-stock-minimo").value);
    const motivo      = document.getElementById("modal-motivo").value.trim();

    if (isNaN(stockActual) || isNaN(stockMinimo) || stockActual < 0 || stockMinimo < 0) {
      alert("Valores de stock inválidos.");
      return;
    }

    try {
      await fetchAPI(`/inventario/${idProd}`, "PUT", {
        stock_actual: stockActual,
        stock_minimo: stockMinimo,
        motivo: motivo || null,
      });
      cerrarModal();
      await cargarInventario();
    } catch (err) {
      alert(`Error al guardar: ${err.message}`);
    }
  }

  // Cerrar modal al hacer clic fuera
  document.getElementById("modal-ajuste").addEventListener("click", e => {
    if (e.target === document.getElementById("modal-ajuste")) cerrarModal();
  });

  // ── Helper ───────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

