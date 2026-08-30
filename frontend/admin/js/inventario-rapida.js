
  requireAuth(ROLES.ADMIN);
  applyRoleVisibility();

  const nombreUsuario = getUserNombre();
  if (nombreUsuario) document.getElementById("sidebar-username").textContent = nombreUsuario;

  // ── Estado ───────────────────────────────────────────────────────────────
  let productos = [];          // items de la página actual
  // id_producto -> { nuevoStock, stockMinimo, nombre } — persiste entre páginas
  const cambios = new Map();
  let paginaActual = 1;
  let debounceBusqueda = null;
  const LIMITE_PAGINA = 15;

  document.addEventListener("DOMContentLoaded", () => cargar());

  function paramsRapida() {
    const p = new URLSearchParams();
    p.set("page", paginaActual);
    p.set("limit", LIMITE_PAGINA);
    const q = document.getElementById("filtro-nombre").value.trim();
    if (q) p.set("q", q);
    const cat = document.getElementById("filtro-categoria").value;
    if (cat) p.set("categoria", cat);
    return p.toString();
  }

  async function cargar() {
    try {
      const data = await fetchAPI(`/inventario/?${paramsRapida()}`, "GET");

      if (data.pages && paginaActual > data.pages) {
        paginaActual = data.pages;
        return cargar();
      }

      productos = Array.isArray(data.items) ? data.items : [];
      poblarCategorias(data.categorias || []);
      renderTabla();
      renderPaginador("paginador", {
        page: data.page, pages: data.pages, total: data.total, limit: data.limit,
        onPage: (n) => { paginaActual = n; cargar(); window.scrollTo({ top: 0, behavior: "smooth" }); },
      });
    } catch (err) {
      document.getElementById("rapida-tbody").innerHTML =
        `<tr><td colspan="4" class="table-empty">Error al cargar: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function onFiltroChange() {
    paginaActual = 1;
    cargar();
  }

  function onBusquedaInput() {
    clearTimeout(debounceBusqueda);
    debounceBusqueda = setTimeout(() => { paginaActual = 1; cargar(); }, 300);
  }

  function poblarCategorias(categorias) {
    const select = document.getElementById("filtro-categoria");
    const sel = select.value;
    const todas = [...new Set([...(categorias || []), sel].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "es"));
    select.innerHTML =
      `<option value="">Todas las categorías</option>` +
      todas.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    select.value = sel;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  // `productos` ya viene filtrado y paginado por el backend.
  function renderTabla() {
    const tbody = document.getElementById("rapida-tbody");
    if (productos.length === 0) {
      const hayFiltro = document.getElementById("filtro-nombre").value.trim() ||
                        document.getElementById("filtro-categoria").value;
      tbody.innerHTML = `<tr><td colspan="4" class="table-empty">${
        hayFiltro ? "Sin resultados para el filtro." : "No hay productos con control de stock."
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = productos.map(p => {
      const actual = Number(p.stock_actual) || 0;
      const tocado = cambios.has(p.id_producto);
      const valor = tocado ? cambios.get(p.id_producto).nuevoStock : actual;
      return `
        <tr class="${tocado ? "row-tocada" : ""}">
          <td><div class="inv-product-name">${escapeHtml(p.nombre)}</div></td>
          <td><div class="inv-category">${escapeHtml(p.categoria || "—")}</div></td>
          <td class="stock-actual-cell">${actual}</td>
          <td>
            <input type="number" min="0" step="1" class="stock-input"
              value="${valor}" data-id="${p.id_producto}" data-actual="${actual}"
              data-min="${Number(p.stock_minimo) || 0}" data-nombre="${escapeHtml(p.nombre)}"
              oninput="onStockInput(this)" />
          </td>
        </tr>`;
    }).join("");
  }

  function onStockInput(input) {
    const id = Number(input.dataset.id);
    const actual = Number(input.dataset.actual);
    const nuevo = input.value === "" ? null : Math.trunc(Number(input.value));

    if (nuevo === null || Number.isNaN(nuevo) || nuevo === actual || nuevo < 0) {
      cambios.delete(id);
    } else {
      cambios.set(id, {
        nuevoStock: nuevo,
        stockMinimo: Number(input.dataset.min) || 0,
        nombre: input.dataset.nombre || `#${id}`,
      });
    }
    input.closest("tr").classList.toggle("row-tocada", cambios.has(id));
    actualizarBarra();
  }

  function actualizarBarra() {
    const bar = document.getElementById("save-bar");
    document.getElementById("save-count").textContent = cambios.size;
    bar.hidden = cambios.size === 0;
  }

  // ── Guardar ──────────────────────────────────────────────────────────────
  async function guardarTodo() {
    if (cambios.size === 0) return;
    const btn = document.getElementById("btn-guardar-todo");
    btn.disabled = true;
    btn.textContent = "Guardando…";

    let ok = 0;
    const errores = [];

    for (const [id, cambio] of [...cambios.entries()]) {
      try {
        await fetchAPI(`/inventario/${id}`, "PUT", {
          stock_actual: cambio.nuevoStock,
          stock_minimo: cambio.stockMinimo,
          motivo: "Reposición rápida",
        });
        cambios.delete(id);
        ok++;
      } catch (err) {
        errores.push(`${cambio.nombre}: ${err.message}`);
      }
    }

    btn.disabled = false;
    btn.textContent = "Guardar cambios";

    if (errores.length === 0) {
      mostrarToast(`${ok} producto(s) actualizado(s).`, "success");
    } else {
      mostrarToast(`${ok} guardado(s), ${errores.length} con error: ${errores[0]}`, "error");
    }
    await cargar();
    actualizarBarra();
  }

  function descartarCambios() {
    cambios.clear();
    actualizarBarra();
    renderTabla();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  let toastTimer;
  function mostrarToast(mensaje, tipo = "success") {
    const toast = document.getElementById("toast");
    toast.textContent = mensaje;
    toast.className = `toast ${tipo} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
