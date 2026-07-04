
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    // Solo admins pueden acceder a este panel
    if (!requireAuth(ROLES.ADMIN)) throw new Error();

    // Mostrar nombre del usuario en sidebar
    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
    }

    // ── ESTADO LOCAL ────────────────────────────────────────────
    let todosLosProductos = [];   // cache de productos para filtrado local
    let modoEdicion       = false;
    let idEditando        = null;
    let idAEliminar       = null;
    const subcategoriasPorCategoria = {
      Comidas: ["Hamburguesas", "Papas Fritas", "Entraditas", "Pizzas"],
      Cocteleria: ["Bebida sin alcohol", "Gin Tonic", "Super Clasicos"],
    };

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", cargarProductos);

    // ── CARGAR PRODUCTOS ────────────────────────────────────────
    async function cargarProductos() {
      mostrarCargando();
      try {
        // GET /productos — requiere token (auth=true por defecto)
        const data = await fetchAPI("/productos");
        todosLosProductos = ordenarProductos(Array.isArray(data) ? data : []);
        actualizarFiltroCategorias(todosLosProductos);
        actualizarStats(todosLosProductos);
        filtrarTabla();
      } catch (error) {
        mostrarError("No se pudo cargar la lista de productos: " + error.message);
      }
    }

    function ordenarProductos(productos) {
      return [...productos].sort((a, b) => {
        const idA = Number(a.id_producto) || 0;
        const idB = Number(b.id_producto) || 0;
        return idB - idA;
      });
    }

    // ── STATS ───────────────────────────────────────────────────
    function actualizarStats(productos) {
      const disponibles    = productos.filter(p => p.disponible).length;
      const noDisponibles  = productos.length - disponibles;
      document.getElementById("stat-total").textContent        = productos.length;
      document.getElementById("stat-disponibles").textContent  = disponibles;
      document.getElementById("stat-nodisponibles").textContent = noDisponibles;
    }

    // ── RENDER TABLA ────────────────────────────────────────────
    function renderTabla(productos) {
      const container = document.getElementById("tabla-container");
      document.getElementById("count-label").textContent =
        productos.length === 1 ? "1 producto" : `${productos.length} productos`;

      if (productos.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">...</div>
            <p>No hay productos todavía. ¡Agregá el primero!</p>
          </div>`;
        return;
      }

      const filas = productos.map(p => `
        <tr id="row-${p.id_producto}">
          <td>
            ${p.imagen_url
              ? `<img src="${escapeHtml(p.imagen_url)}" class="product-img" alt="${escapeHtml(p.nombre)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
                 <div class="product-img-placeholder" style="display:none;" aria-label="Sin imagen"></div>`
              : `<div class="product-img-placeholder" aria-label="Sin imagen"></div>`
            }
          </td>
          <td>
            <div class="product-name">${escapeHtml(p.nombre)}</div>
            <div class="product-desc">${escapeHtml(p.descripcion || '—')}</div>
          </td>
          <td>
            <div class="category-stack">
              <span class="category-main">${escapeHtml(p.categoria || '—')}</span>
              ${p.subcategoria ? `<span class="category-sub">${escapeHtml(p.subcategoria)}</span>` : ""}
            </div>
          </td>
          <td class="price-cell">$${Number(p.precio).toFixed(2)}</td>
          <td>
            ${p.disponible
              ? '<span class="status-badge status-available"><span class="status-dot"></span>Disponible</span>'
              : '<span class="status-badge status-unavailable"><span class="status-dot"></span>No disponible</span>'
            }
          </td>
          <td>
            <div class="table-actions">
              <button class="btn-edit"   onclick="abrirModalEditar(${p.id_producto})">Editar</button>
              <button class="btn-delete" onclick="pedirConfirmacion(${p.id_producto}, '${escapeHtml(p.nombre)}')">Eliminar</button>
            </div>
          </td>
        </tr>
      `).join("");

      container.innerHTML = `
        <table>
          <colgroup>
            <col class="col-img">
            <col class="col-producto">
            <col class="col-categoria">
            <col class="col-precio">
            <col class="col-estado">
            <col class="col-acciones">
          </colgroup>
          <thead>
            <tr>
              <th>Imagen</th>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Precio</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>`;
    }

    // ── FILTRO DE BÚSQUEDA ──────────────────────────────────────
    function filtrarTabla() {
      const q = document.getElementById("search-input").value.toLowerCase();
      const categoria = document.getElementById("category-filter")?.value || "";
      const filtrados = todosLosProductos.filter(p =>
        (!categoria || (p.categoria || "") === categoria) &&
        (
          (p.nombre || "").toLowerCase().includes(q) ||
          (p.descripcion || "").toLowerCase().includes(q) ||
          (p.categoria   || "").toLowerCase().includes(q) ||
          (p.subcategoria || "").toLowerCase().includes(q)
        )
      );
      renderTabla(filtrados);
    }

    function actualizarFiltroCategorias(productos) {
      const select = document.getElementById("category-filter");
      if (!select) return;

      const seleccionActual = select.value;
      const categorias = [...new Set(
        productos
          .map(p => p.categoria)
          .filter(Boolean)
      )].sort((a, b) => a.localeCompare(b, "es"));

      select.innerHTML = `
        <option value="">Todas las categorias</option>
        ${categorias.map(categoria => (
          `<option value="${escapeHtml(categoria)}">${escapeHtml(categoria)}</option>`
        )).join("")}
      `;

      if (categorias.includes(seleccionActual)) {
        select.value = seleccionActual;
      }
    }

    // ── MODAL CREAR ─────────────────────────────────────────────
    function abrirModalCrear() {
      modoEdicion = false;
      idEditando  = null;
      document.getElementById("modal-title").textContent = "Agregar producto";
      document.getElementById("btn-guardar").textContent = "Guardar producto";
      limpiarFormulario();
      abrirModal();
    }

    // ── MODAL EDITAR ────────────────────────────────────────────
    function abrirModalEditar(id) {
      const producto = todosLosProductos.find(p => p.id_producto === id);
      if (!producto) return;

      modoEdicion = true;
      idEditando  = id;

      document.getElementById("modal-title").textContent = "Editar producto";
      document.getElementById("btn-guardar").textContent = "Guardar cambios";

      // Prerellenar formulario con datos del producto
      document.getElementById("f-nombre").value      = producto.nombre       || "";
      document.getElementById("f-descripcion").value = producto.descripcion  || "";
      document.getElementById("f-precio").value      = producto.precio       || "";
      document.getElementById("f-categoria").value   = producto.categoria    || "";
      actualizarSubcategoriasAdmin(producto.subcategoria || "");
      document.getElementById("f-imagen").value      = producto.imagen_url   || "";
      document.getElementById("f-disponible").checked = !!producto.disponible;

      abrirModal();
    }

    // ── GUARDAR (CREAR O EDITAR) ─────────────────────────────────
    async function guardarProducto() {
      const nombre     = document.getElementById("f-nombre").value.trim();
      const descripcion = document.getElementById("f-descripcion").value.trim();
      const precio     = parseFloat(document.getElementById("f-precio").value);
      const categoria  = document.getElementById("f-categoria").value;
      const subcategoria = document.getElementById("f-subcategoria").value || null;
      const imagen_url = document.getElementById("f-imagen").value.trim();
      const disponible = document.getElementById("f-disponible").checked;

      // Validaciones
      if (!nombre) { mostrarToast("El nombre es obligatorio.", "error"); return; }
      if (isNaN(precio) || precio < 0) { mostrarToast("Ingresá un precio válido.", "error"); return; }
      if (!categoria) { mostrarToast("Seleccioná una categoría.", "error"); return; }

      const body = { nombre, descripcion, precio, categoria, subcategoria, imagen_url, disponible };

      const btn = document.getElementById("btn-guardar");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Guardando...';

      try {
        if (modoEdicion) {
          // PUT /productos/{id}
          await fetchAPI(`/productos/${idEditando}`, "PUT", body);
          mostrarToast("Producto actualizado correctamente.", "success");
        } else {
          // POST /productos
          await fetchAPI("/productos", "POST", body);
          mostrarToast("Producto creado correctamente.", "success");
        }
        cerrarModal();
        await cargarProductos(); // recarga la tabla
      } catch (error) {
        mostrarToast("Error: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = modoEdicion ? "Guardar cambios" : "Guardar producto";
      }
    }

    // ── ELIMINAR ────────────────────────────────────────────────
    function pedirConfirmacion(id, nombre) {
      idAEliminar = id;
      document.getElementById("confirm-msg").textContent =
        `¿Seguro que querés eliminar "${nombre}"? Esta acción no se puede deshacer.`;
      document.getElementById("confirm-overlay").classList.add("open");
    }

    function cerrarConfirm() {
      idAEliminar = null;
      document.getElementById("confirm-overlay").classList.remove("open");
    }

    async function confirmarEliminar() {
      if (!idAEliminar) return;

      const btn = document.getElementById("btn-confirm-delete");
      btn.disabled = true;
      btn.textContent = "Eliminando...";

      try {
        // DELETE /productos/{id}
        await fetchAPI(`/productos/${idAEliminar}`, "DELETE");
        mostrarToast("Producto eliminado.", "success");
        cerrarConfirm();
        await cargarProductos(); // recarga la tabla
      } catch (error) {
        mostrarToast("Error al eliminar: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Sí, eliminar";
      }
    }

    // ── HELPERS DE MODAL ────────────────────────────────────────
    function abrirModal() {
      document.getElementById("modal-overlay").classList.add("open");
    }

    function cerrarModal() {
      document.getElementById("modal-overlay").classList.remove("open");
      limpiarFormulario();
    }

    function cerrarModalSiClickAfuera(event) {
      if (event.target === document.getElementById("modal-overlay")) {
        cerrarModal();
      }
    }

    function limpiarFormulario() {
      document.getElementById("f-nombre").value      = "";
      document.getElementById("f-descripcion").value = "";
      document.getElementById("f-precio").value      = "";
      document.getElementById("f-categoria").value   = "";
      actualizarSubcategoriasAdmin("");
      document.getElementById("f-imagen").value      = "";
      document.getElementById("f-disponible").checked = true;
    }

    // ── HELPERS DE UI ───────────────────────────────────────────
    function mostrarCargando() {
      document.getElementById("tabla-container").innerHTML = `
        <div class="empty-state">
          <div class="icon">!</div>
          <p>Cargando productos...</p>
        </div>`;
    }

    function mostrarError(msg) {
      document.getElementById("tabla-container").innerHTML = `
        <div class="empty-state">
          <div class="icon">️</div>
          <p>${escapeHtml(msg)}</p>
        </div>`;
    }

    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = mensaje;
      toast.className   = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }

    function actualizarSubcategoriasAdmin(valorSeleccionado = "") {
      const categoria = document.getElementById("f-categoria")?.value || "";
      const select = document.getElementById("f-subcategoria");
      if (!select) return;

      const opciones = subcategoriasPorCategoria[categoria] || [];
      select.innerHTML = `
        <option value="">Sin subcategoria</option>
        ${opciones.map(opcion => `<option value="${escapeHtml(opcion)}">${escapeHtml(opcion)}</option>`).join("")}
      `;
      select.value = valorSeleccionado;
    }

    document.addEventListener("DOMContentLoaded", () => {
      const categoriaSelect = document.getElementById("f-categoria");
      if (categoriaSelect) {
        categoriaSelect.addEventListener("change", () => actualizarSubcategoriasAdmin(""));
      }
      actualizarSubcategoriasAdmin("");
    });

    // Previene XSS al insertar texto en el HTML
    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // Cerrar confirm con Escape
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        cerrarModal();
        cerrarConfirm();
      }
    });
