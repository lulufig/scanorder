
  requireAuth(ROLES.ADMIN);
  applyRoleVisibility();

  const nombreUsuario = getUserNombre();
  if (nombreUsuario) document.getElementById("sidebar-username").textContent = nombreUsuario;

  // ── Estado ───────────────────────────────────────────────────────────────
  let productos = [];
  // id_producto -> nuevo valor de stock (solo filas que el admin tocó)
  const cambios = new Map();

  document.addEventListener("DOMContentLoaded", cargar);

  async function cargar() {
    try {
      productos = await fetchAPI("/inventario/", "GET");
      poblarCategorias();
      renderTabla();
    } catch (err) {
      document.getElementById("rapida-tbody").innerHTML =
        `<tr><td colspan="4" class="table-empty">Error al cargar: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function poblarCategorias() {
    const select = document.getElementById("filtro-categoria");
    const seleccion = select.value;
    const categorias = [...new Set(productos.map(p => p.categoria).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "es"));
    select.innerHTML =
      `<option value="">Todas las categorías</option>` +
      categorias.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (categorias.includes(seleccion)) select.value = seleccion;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function renderTabla() {
    const q = document.getElementById("filtro-nombre").value.trim().toLowerCase();
    const categoria = document.getElementById("filtro-categoria").value;

    const filtrados = productos.filter(p => {
      const pasaNombre = !q || (p.nombre || "").toLowerCase().includes(q);
      const pasaCategoria = !categoria || (p.categoria || "") === categoria;
      return pasaNombre && pasaCategoria;
    });

    const tbody = document.getElementById("rapida-tbody");
    if (filtrados.length === 0) {
      const mensaje = productos.length === 0
        ? `No hay productos con control de stock.`
        : "Sin resultados para el filtro.";
      tbody.innerHTML = `<tr><td colspan="4" class="table-empty">${mensaje}</td></tr>`;
      return;
    }

    tbody.innerHTML = filtrados.map(p => {
      const actual = Number(p.stock_actual) || 0;
      const valor = cambios.has(p.id_producto) ? cambios.get(p.id_producto) : actual;
      const tocado = cambios.has(p.id_producto);
      return `
        <tr class="${tocado ? "row-tocada" : ""}">
          <td><div class="inv-product-name">${escapeHtml(p.nombre)}</div></td>
          <td><div class="inv-category">${escapeHtml(p.categoria || "—")}</div></td>
          <td class="stock-actual-cell">${actual}</td>
          <td>
            <input type="number" min="0" step="1" class="stock-input"
              value="${valor}" data-id="${p.id_producto}" data-actual="${actual}"
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
      cambios.set(id, nuevo);
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

    const pendientes = [...cambios.entries()];
    let ok = 0;
    const errores = [];

    for (const [id, nuevoStock] of pendientes) {
      const prod = productos.find(p => p.id_producto === id);
      if (!prod) continue;
      try {
        await fetchAPI(`/inventario/${id}`, "PUT", {
          stock_actual: nuevoStock,
          stock_minimo: Number(prod.stock_minimo) || 0,
          motivo: "Reposición rápida",
        });
        cambios.delete(id);
        ok++;
      } catch (err) {
        errores.push(`${prod.nombre}: ${err.message}`);
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
