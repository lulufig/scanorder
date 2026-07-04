
  requireAuth(ROLES.ADMIN);

  // Mostrar nombre del usuario en sidebar
  const nombre = getUserNombre();
  if (nombre) document.getElementById("sidebar-username").textContent = nombre;

  // ── Estado ───────────────────────────────────────────────────────────────
  let inventario = [];
  const STOCK_REFERENCIAS_KEY = "scanorder_stock_referencias";

  // ── Carga inicial ────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    cargarInventario();
    setInterval(cargarInventario, 5000);
  });

  async function cargarInventario() {
    try {
      inventario = await fetchAPI("/inventario/", "GET");
      actualizarAlerta();
      renderTabla();
    } catch (err) {
      document.getElementById("inv-tbody").innerHTML =
        `<tr><td colspan="5" class="table-empty">
           Error al cargar inventario: ${escapeHtml(err.message)}
         </td></tr>`;
    }
  }

  // ── Alerta global de stock bajo ──────────────────────────────────────────
  function actualizarAlerta() {
    const bajos = inventario.filter(p => normalizarEstado(p) !== "OK").length;
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
      const estado = normalizarEstado(p);
      const pasaEstado =
        !filtroEstado ||
        (filtroEstado === "CRITICOS" ? estado !== "OK" : estado === filtroEstado);
      const pasaNombre = !filtroNombre || p.nombre.toLowerCase().includes(filtroNombre);
      return pasaEstado && pasaNombre;
    });

    const tbody = document.getElementById("inv-tbody");

    if (filtrado.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty">Sin resultados</td></tr>`;
      return;
    }

    tbody.innerHTML = filtrado.map(p => {
      const estado = normalizarEstado(p);
      const subcategoria = p.subcategoria ? `<div class="inv-subcategory">${escapeHtml(p.subcategoria)}</div>` : "";

      return `
      <tr class="${estado === "AGOTADO" ? "row-agotado" : estado === "BAJO" ? "row-bajo" : ""}">
        <td>
          <div class="inv-product-name">${escapeHtml(p.nombre)}</div>
        </td>
        <td>
          <div class="inv-category">${escapeHtml(p.categoria || "—")}</div>
          ${subcategoria}
        </td>
        <td>${stockCell(p, estado)}</td>
        <td>${badgeEstado(estado)}</td>
        <td>
          <button class="btn-ajustar"
            onclick="abrirModal(${p.id_producto}, '${escapeHtml(p.nombre).replace(/'/g, "\\'")}', ${p.stock_actual}, ${p.stock_minimo})">
            Ajustar
          </button>
        </td>
      </tr>`;
    }).join("");
  }

  function normalizarEstado(producto) {
    const actual = Number(producto.stock_actual) || 0;
    const minimo = Number(producto.stock_minimo) || 0;
    if (actual <= 0) return "AGOTADO";
    if (minimo > 0 && actual < minimo) return "BAJO";
    return "OK";
  }

  function stockCell(producto, estado) {
    const actual = Number(producto.stock_actual) || 0;
    const minimo = Number(producto.stock_minimo) || 0;
    const referencia = obtenerReferenciaStock(producto.id_producto, actual, minimo);
    const porcentaje = referencia > 0
      ? Math.max(0, Math.min(100, Math.round((actual / referencia) * 100)))
      : 0;
    const color = estado === "AGOTADO" ? "#b42318" : estado === "BAJO" ? "#b7791f" : "#256f4b";

    return `
      <div class="stock-cell">
        <div class="stock-meta">
          <span class="stock-current">${actual}</span>
          <span class="stock-min">mín. ${minimo}</span>
        </div>
        <div class="stock-bar" aria-label="Stock ${actual}, mínimo ${minimo}, referencia ${referencia}">
          <span class="stock-fill" style="--stock-pct:${porcentaje}%;--stock-color:${color};"></span>
        </div>
      </div>`;
  }

  function obtenerReferenciaStock(idProducto, actual, minimo) {
    const id = String(idProducto);
    const referencias = leerReferenciasStock();
    const referenciaGuardada = Number(referencias[id]) || 0;
    const referencia = Math.max(referenciaGuardada, actual, minimo, 1);

    if (referencia !== referenciaGuardada) {
      referencias[id] = referencia;
      guardarReferenciasStock(referencias);
    }

    return referencia;
  }

  function leerReferenciasStock() {
    try {
      return JSON.parse(localStorage.getItem(STOCK_REFERENCIAS_KEY) || "{}");
    } catch (_) {
      return {};
    }
  }

  function guardarReferenciasStock(referencias) {
    try {
      localStorage.setItem(STOCK_REFERENCIAS_KEY, JSON.stringify(referencias));
    } catch (_) {
      // Si localStorage no esta disponible, la barra sigue funcionando con el valor actual.
    }
  }

  function badgeEstado(estado) {
    const map = {
      OK:      '<span class="badge badge-ok">Stock OK</span>',
      BAJO:    '<span class="badge badge-bajo">Bajo mínimo</span>',
      AGOTADO: '<span class="badge badge-agotado">Agotado</span>',
    };
    return map[estado] || estado;
  }

  function verCriticos() {
    document.getElementById("filtro-estado").value = "CRITICOS";
    renderTabla();
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

