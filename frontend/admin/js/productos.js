
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    // Solo admins pueden acceder a este panel
    if (!requireAuth(ROLES.ADMIN)) throw new Error();
    applyRoleVisibility();

    // Mostrar nombre del usuario en sidebar
    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
    }

    // ── ESTADO LOCAL ────────────────────────────────────────────
    let todosLosProductos     = [];   // items de la página actual (no todos)
    let categoriasDisponibles = [];   // nombres de categoría con productos (del backend)
    let modoEdicion           = false;
    let idEditando            = null;
    let idAEliminar           = null;
    let idRecienCreado        = null; // se resalta la fila del último producto creado
    let paginaActual          = 1;
    let debounceBusqueda      = null;
    const LIMITE_PAGINA = 10;
    // Categorías que siempre aparecen en el modal aunque todavía no tengan productos.
    const CATEGORIAS_BASE = ["Comidas", "Cervezas", "Cocteleria", "Postres"];

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
      cargarProductos();
    });

    // ── CARGAR PRODUCTOS (server-side: filtros + orden + paginación) ──
    function paramsCatalogo() {
      const p = new URLSearchParams();
      p.set("page", paginaActual);
      p.set("limit", LIMITE_PAGINA);
      const q = document.getElementById("search-input").value.trim();
      if (q) p.set("q", q);
      p.set("estado", document.getElementById("estado-filter").value || "disponibles");
      const cat = document.getElementById("category-filter").value;
      if (cat) p.set("categoria", cat);
      p.set("orden", document.getElementById("listado-filter").value || "mas-vendidos");
      return p.toString();
    }

    async function cargarProductos() {
      mostrarCargando();
      try {
        const data = await fetchAPI(`/productos/catalogo?${paramsCatalogo()}`);

        // Si borrás/desactivás el último ítem de la última página, volvés a la anterior.
        if (data.pages && paginaActual > data.pages) {
          paginaActual = data.pages;
          return cargarProductos();
        }

        todosLosProductos     = Array.isArray(data.items) ? data.items : [];
        categoriasDisponibles = Array.isArray(data.categorias) ? data.categorias : [];
        actualizarFiltroCategorias(categoriasDisponibles);
        actualizarStats(data.resumen || {});

        const agrupado = document.getElementById("listado-filter").value === "categoria";
        renderTabla(todosLosProductos, agrupado);

        document.getElementById("count-label").textContent =
          data.total === 1 ? "1 producto" : `${data.total} productos`;

        renderPaginador("paginador", {
          page: data.page, pages: data.pages, total: data.total, limit: data.limit,
          onPage: (n) => {
            paginaActual = n;
            cargarProductos();
            window.scrollTo({ top: 0, behavior: "smooth" });
          },
        });
      } catch (error) {
        mostrarError("No se pudo cargar la lista de productos: " + error.message);
      }
    }

    // ── STATS ───────────────────────────────────────────────────
    function actualizarStats(resumen) {
      document.getElementById("stat-total").textContent        = resumen.total ?? "—";
      document.getElementById("stat-disponibles").textContent  = resumen.disponibles ?? "—";
      document.getElementById("stat-nodisponibles").textContent = resumen.no_disponibles ?? "—";
    }

    // ── RENDER TABLA ────────────────────────────────────────────
    // `agrupado` = true dibuja una fila-encabezado por categoría.
    function renderTabla(productos, agrupado = false) {
      const container = document.getElementById("tabla-container");

      if (productos.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">...</div>
            <p>No hay productos para los filtros aplicados.</p>
          </div>`;
        return;
      }

      const cuerpo = agrupado
        ? filasAgrupadas(productos)
        : productos.map(filaProducto).join("");

      container.innerHTML = `
        <table>
          <colgroup>
            <col class="col-producto">
            <col class="col-categoria">
            <col class="col-precio">
            <col class="col-estado">
            <col class="col-acciones">
          </colgroup>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Precio</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>${cuerpo}</tbody>
        </table>`;

      resaltarRecienCreado();
    }

    function filaProducto(p) {
      const esNuevo = idRecienCreado != null && Number(p.id_producto) === Number(idRecienCreado);
      return `
        <tr id="row-${p.id_producto}"${esNuevo ? ' class="row-nuevo"' : ""}>
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
          <td class="price-cell">${formatearPrecio(p.precio)}</td>
          <td>
            ${p.disponible
              ? '<span class="status-badge status-available"><span class="status-dot"></span>Disponible</span>'
              : '<span class="status-badge status-unavailable"><span class="status-dot"></span>No disponible</span>'
            }
          </td>
          <td>
            <div class="table-actions">
              <button class="btn-edit" onclick="abrirModalEditar(${p.id_producto})">Editar</button>
              ${p.disponible
                ? `<button class="btn-delete" onclick="pedirConfirmacion(${p.id_producto})">Desactivar</button>`
                : `<button class="btn-reactivar" onclick="reactivarProducto(${p.id_producto}, this)">Reactivar</button>`
              }
            </div>
          </td>
        </tr>
      `;
    }

    // El backend ya ordena por (categoría, id desc) cuando el orden es "categoria".
    // Acá solo insertamos una fila-encabezado al cambiar de categoría; si un bloque
    // cruza de página, el encabezado se repite en la página siguiente (a propósito).
    function filasAgrupadas(productos) {
      let html = "";
      let catActual = null;
      productos.forEach(p => {
        const cat = p.categoria || "Sin categoría";
        if (cat !== catActual) {
          catActual = cat;
          html += `<tr class="group-row"><td colspan="5">${escapeHtml(cat)}</td></tr>`;
        }
        html += filaProducto(p);
      });
      return html;
    }

    function resaltarRecienCreado() {
      if (idRecienCreado == null) return;
      const fila = document.getElementById(`row-${idRecienCreado}`);
      if (fila) {
        fila.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      // El realce dura una sola pasada de render.
      idRecienCreado = null;
    }

    // ── FILTROS ────────────────────────────────────────────────
    // Selects → recargan al instante; el buscador con debounce de 300ms.
    // Cualquier cambio de filtro vuelve a la página 1.
    function onFiltroChange() {
      paginaActual = 1;
      cargarProductos();
    }

    function onBusquedaInput() {
      clearTimeout(debounceBusqueda);
      debounceBusqueda = setTimeout(() => {
        paginaActual = 1;
        cargarProductos();
      }, 300);
    }

    function actualizarFiltroCategorias(categorias) {
      const select = document.getElementById("category-filter");
      if (!select) return;
      const sel = select.value;
      // Mantiene la selección actual aunque el filtro combinado la deje sin resultados.
      const todas = [...new Set([...(categorias || []), sel].filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "es"));
      select.innerHTML = `<option value="">Todas las categorías</option>` +
        todas.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
      select.value = sel;
    }

    // ── MODAL CREAR ─────────────────────────────────────────────
    function abrirModalCrear() {
      modoEdicion = false;
      idEditando  = null;
      document.getElementById("modal-title").textContent = "Agregar producto";
      document.getElementById("btn-guardar").textContent = "Guardar producto";
      limpiarFormulario();
      poblarCategoriasModal("");
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

      limpiarErrorModal();
      // Prerellenar formulario con datos del producto
      document.getElementById("f-nombre").value      = producto.nombre       || "";
      document.getElementById("f-descripcion").value = producto.descripcion  || "";
      document.getElementById("f-precio").value      = producto.precio       || "";
      poblarCategoriasModal(producto.categoria || "");
      document.getElementById("f-subcategoria").value = producto.subcategoria || "";
      document.getElementById("f-disponible").checked = !!producto.disponible;
      document.getElementById("f-controla-stock").checked = !!producto.controla_stock;

      abrirModal();
    }

    // ── GUARDAR (CREAR O EDITAR) ─────────────────────────────────
    async function guardarProducto() {
      const nombre      = document.getElementById("f-nombre").value.trim();
      const descripcion = document.getElementById("f-descripcion").value.trim();
      const precio      = parseFloat(document.getElementById("f-precio").value);
      const subcategoria = document.getElementById("f-subcategoria").value.trim() || null;
      const disponible  = document.getElementById("f-disponible").checked;
      const controla_stock = document.getElementById("f-controla-stock").checked;

      let categoria = document.getElementById("f-categoria").value;
      if (categoria === "__nueva__") {
        categoria = document.getElementById("f-categoria-nueva").value.trim();
      }

      // Validaciones — se muestran inline, debajo del encabezado del modal.
      limpiarErrorModal();
      if (!nombre) { mostrarErrorModal("El nombre es obligatorio."); return; }
      if (isNaN(precio) || precio <= 0) { mostrarErrorModal("Ingresá un precio válido (mayor a 0)."); return; }
      if (!categoria) { mostrarErrorModal("Elegí una categoría o escribí una nueva."); return; }

      const body = { nombre, descripcion, precio, categoria, subcategoria, disponible, controla_stock };

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
          const creado = await fetchAPI("/productos", "POST", body);
          mostrarToast("Producto creado correctamente.", "success");
          // Dejar el nuevo producto visible como fila 1: filtramos por su categoría
          // y ordenamos por "recién agregados".
          idRecienCreado = creado?.id_producto ?? null;
          document.getElementById("listado-filter").value = "recientes";
          document.getElementById("estado-filter").value = "todos";
          document.getElementById("category-filter").value = creado?.categoria || "";
          document.getElementById("search-input").value = "";
          paginaActual = 1;
        }
        cerrarModal();
        await cargarProductos(); // recarga la tabla
      } catch (error) {
        // El modal queda abierto; el error se ve inline sin perder lo cargado.
        mostrarErrorModal(error.message || "No se pudo guardar el producto.");
      } finally {
        btn.disabled = false;
        btn.innerHTML = modoEdicion ? "Guardar cambios" : "Guardar producto";
      }
    }

    // ── DESACTIVAR (baja lógica) ────────────────────────────────
    function pedirConfirmacion(id) {
      const p = todosLosProductos.find(x => x.id_producto === id);
      const nombre = p ? p.nombre : "este producto";
      idAEliminar = id;
      document.getElementById("confirm-msg").textContent =
        `"${nombre}" dejará de aparecer en el menú. Podés reactivarlo cuando quieras.`;
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
      btn.textContent = "Desactivando...";

      try {
        // DELETE /productos/{id} — baja lógica: el backend solo pone disponible = FALSE
        await fetchAPI(`/productos/${idAEliminar}`, "DELETE");
        mostrarToast("Producto desactivado.", "success");
        cerrarConfirm();
        await cargarProductos(); // recarga la tabla
      } catch (error) {
        mostrarToast("Error al desactivar: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Desactivar";
      }
    }

    // ── REACTIVAR ───────────────────────────────────────────────
    async function reactivarProducto(id, btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = "Reactivando...";

      try {
        // PUT /productos/{id} — solo se envía disponible, el resto de los
        // campos quedan sin tocar (el backend hace COALESCE por campo).
        await fetchAPI(`/productos/${id}`, "PUT", { disponible: true });
        mostrarToast("Producto reactivado.", "success");
        await cargarProductos(); // recarga la tabla
      } catch (error) {
        mostrarToast("Error al reactivar: " + error.message, "error");
        btnEl.disabled = false;
        btnEl.textContent = "Reactivar";
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
      document.getElementById("f-nombre").value       = "";
      document.getElementById("f-descripcion").value  = "";
      document.getElementById("f-precio").value       = "";
      document.getElementById("f-categoria").value    = "";
      document.getElementById("f-categoria-nueva").value = "";
      document.getElementById("f-categoria-nueva-group").hidden = true;
      document.getElementById("f-subcategoria").value = "";
      document.getElementById("f-disponible").checked = true;
      document.getElementById("f-controla-stock").checked = true;
      limpiarErrorModal();
    }

    // ── CATEGORÍAS DEL MODAL ────────────────────────────────────
    // Llena el <select> con las categorías reales (base + las que ya usan
    // productos) más la opción "＋ Nueva categoría…".
    function poblarCategoriasModal(seleccion = "") {
      const select = document.getElementById("f-categoria");
      const categorias = new Set(CATEGORIAS_BASE);
      categoriasDisponibles.forEach(c => categorias.add(c));
      if (seleccion) categorias.add(seleccion);

      const ordenadas = [...categorias].sort((a, b) => a.localeCompare(b, "es"));
      select.innerHTML = `
        <option value="">Seleccioná...</option>
        ${ordenadas.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
        <option value="__nueva__">＋ Nueva categoría…</option>
      `;
      select.value = seleccion || "";
      onCategoriaModalChange();
    }

    function onCategoriaModalChange() {
      const esNueva = document.getElementById("f-categoria").value === "__nueva__";
      document.getElementById("f-categoria-nueva-group").hidden = !esNueva;
      if (esNueva) {
        document.getElementById("f-categoria-nueva").focus();
      } else {
        document.getElementById("f-categoria-nueva").value = "";
      }
    }

    function mostrarErrorModal(msg) {
      const el = document.getElementById("f-error");
      el.textContent = msg;
      el.classList.add("visible");
    }

    function limpiarErrorModal() {
      document.getElementById("f-error").classList.remove("visible");
    }

    function formatearPrecio(valor) {
      const n = Number(valor) || 0;
      return "$" + n.toLocaleString("es-AR", {
        minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: 2,
      });
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
