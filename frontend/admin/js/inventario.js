
  requireAuth(ROLES.ADMIN);
  applyRoleVisibility();

  // Mostrar nombre del usuario en sidebar
  const nombre = getUserNombre();
  if (nombre) document.getElementById("sidebar-username").textContent = nombre;

  // ── Estado ───────────────────────────────────────────────────────────────
  let inventario = [];        // items de la página actual
  let resumenActual = {};     // contadores globales (ok/bajo/agotado/criticos)
  let paginaActual = 1;
  let debounceBusqueda = null;
  const STOCK_REFERENCIAS_KEY = "scanorder_stock_referencias";
  const LIMITE_PAGINA = 10;

  // ── Carga inicial ────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    aplicarFiltroDesdeUrl();
    cargarInventario();
    // Refresco en vivo del stock; mantiene la página y los filtros actuales.
    setInterval(() => cargarInventario(true), 5000);
  });

  function aplicarFiltroDesdeUrl() {
    const params = new URLSearchParams(window.location.search);
    const estado = params.get("estado");
    const filtroEstado = document.getElementById("filtro-estado");
    if (estado === "CRITICOS" && filtroEstado) {
      filtroEstado.value = "CRITICOS";
    }
  }

  function paramsInventario() {
    const p = new URLSearchParams();
    p.set("page", paginaActual);
    p.set("limit", LIMITE_PAGINA);
    const q = document.getElementById("filtro-nombre").value.trim();
    if (q) p.set("q", q);
    const est = document.getElementById("filtro-estado").value;
    if (est) p.set("estado", est);
    return p.toString();
  }

  async function cargarInventario(silencioso = false) {
    try {
      const data = await fetchAPI(`/inventario/?${paramsInventario()}`, "GET");

      if (data.pages && paginaActual > data.pages) {
        paginaActual = data.pages;
        return cargarInventario(silencioso);
      }

      inventario = Array.isArray(data.items) ? data.items : [];
      resumenActual = data.resumen || {};
      actualizarAlerta();
      renderTabla();
      renderPaginador("paginador", {
        page: data.page, pages: data.pages, total: data.total, limit: data.limit,
        onPage: (n) => { paginaActual = n; cargarInventario(); window.scrollTo({ top: 0, behavior: "smooth" }); },
      });
    } catch (err) {
      if (silencioso) return;  // un poll fallido no pisa la tabla
      document.getElementById("inv-tbody").innerHTML =
        `<tr><td colspan="5" class="table-empty">
           Error al cargar inventario: ${escapeHtml(err.message)}
         </td></tr>`;
    }
  }

  // ── Filtros ──────────────────────────────────────────────────────────────
  function onFiltroChange() {
    paginaActual = 1;
    cargarInventario();
  }

  function onBusquedaInput() {
    clearTimeout(debounceBusqueda);
    debounceBusqueda = setTimeout(() => { paginaActual = 1; cargarInventario(); }, 300);
  }

  // ── Alerta global de stock bajo ──────────────────────────────────────────
  function actualizarAlerta() {
    const criticos = Number(resumenActual.criticos) || 0;
    const banner = document.getElementById("alerta-bajo-minimo");
    if (criticos > 0) {
      document.getElementById("alerta-count").textContent = criticos;
      banner.classList.add("visible");
    } else {
      banner.classList.remove("visible");
    }
  }

  // ── Render de tabla ──────────────────────────────────────────────────────
  // `inventario` ya viene filtrado y paginado por el backend.
  function renderTabla() {
    const tbody = document.getElementById("inv-tbody");

    if (inventario.length === 0) {
      const hayFiltro = document.getElementById("filtro-nombre").value.trim() ||
                        document.getElementById("filtro-estado").value;
      const mensaje = hayFiltro
        ? "Sin resultados para el filtro."
        : `No hay productos con control de stock. Revisá el checkbox
           "Controlar el stock de este producto" en <a href="productos.html">Productos</a>.`;
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty">${mensaje}</td></tr>`;
      return;
    }

    tbody.innerHTML = inventario.map(p => {
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
          <button class="btn-ajustar" onclick="abrirModal(${p.id_producto})">
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
    onFiltroChange();
  }

  // ── Modal de ajuste ──────────────────────────────────────────────────────
  function abrirModal(idProd) {
    const p = inventario.find(x => x.id_producto === idProd);
    if (!p) return;
    document.getElementById("modal-id-prod").value           = p.id_producto;
    document.getElementById("modal-nombre-prod").textContent = p.nombre;
    document.getElementById("modal-stock-actual").value      = p.stock_actual;
    document.getElementById("modal-stock-minimo").value      = p.stock_minimo;
    document.getElementById("modal-motivo").value            = "";
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

