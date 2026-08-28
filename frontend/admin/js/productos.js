
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
    let todosLosProductos = [];   // cache de productos para filtrado local
    let modoEdicion       = false;
    let idEditando        = null;
    let idAEliminar       = null;
    let idRecienCreado    = null;  // se resalta la fila del último producto creado
    let mostrandoTodos    = false; // expande el top de "Más vendidos" a la lista completa
    const TOPE_MAS_VENDIDOS = 10;
    // Categorías que siempre aparecen en el modal aunque todavía no tengan productos.
    const CATEGORIAS_BASE = ["Comidas", "Cervezas", "Cocteleria", "Postres"];

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
      cargarProductos();
    });

    // ── CARGAR PRODUCTOS ────────────────────────────────────────
    async function cargarProductos() {
      mostrarCargando();
      try {
        // GET /productos — incluye dados de baja porque el panel admin
        // necesita poder verlos y reactivarlos (el menú público no manda este param).
        const data = await fetchAPI("/productos?incluir_no_disponibles=true");
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

    function filasAgrupadas(productos) {
      const grupos = new Map();
      productos.forEach(p => {
        const cat = p.categoria || "Sin categoría";
        if (!grupos.has(cat)) grupos.set(cat, []);
        grupos.get(cat).push(p);
      });

      const categoriasOrdenadas = [...grupos.keys()].sort((a, b) => a.localeCompare(b, "es"));

      return categoriasOrdenadas.map(cat => {
        // Dentro de cada categoría: los más nuevos primero, para que un producto
        // recién agregado aparezca al tope de su bloque.
        const items = grupos.get(cat).sort((a, b) => (Number(b.id_producto) || 0) - (Number(a.id_producto) || 0));
        const encabezado = `
          <tr class="group-row">
            <td colspan="5">${escapeHtml(cat)} <span class="group-count">${items.length}</span></td>
          </tr>`;
        return encabezado + items.map(filaProducto).join("");
      }).join("");
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

    // ── FILTRO DE BÚSQUEDA ──────────────────────────────────────
    // Cualquier cambio de filtro colapsa la expansión "ver catálogo completo".
    function onFiltroChange() {
      mostrandoTodos = false;
      filtrarTabla();
    }

    function filtrarTabla() {
      const q = document.getElementById("search-input").value.toLowerCase();
      const categoria = document.getElementById("category-filter")?.value || "";
      const estado = document.getElementById("estado-filter")?.value || "disponibles";
      const listado = document.getElementById("listado-filter")?.value || "mas-vendidos";

      let filtrados = todosLosProductos.filter(p => {
        const pasaEstado =
          estado === "todos" ||
          (estado === "disponibles" && p.disponible) ||
          (estado === "no-disponibles" && !p.disponible);
        const pasaCategoria = !categoria || (p.categoria || "") === categoria;
        const pasaTexto =
          (p.nombre || "").toLowerCase().includes(q) ||
          (p.descripcion || "").toLowerCase().includes(q) ||
          (p.categoria || "").toLowerCase().includes(q) ||
          (p.subcategoria || "").toLowerCase().includes(q);
        return pasaEstado && pasaCategoria && pasaTexto;
      });

      const agrupado = listado === "categoria";
      filtrados = ordenarPorListado(filtrados, listado);
      const totalCoincidencias = filtrados.length;

      // El tope de 10 + botón SOLO aparecen en la vista por defecto:
      // orden "Más vendidos", "Todas las categorías", estado "Disponibles" y sin
      // búsqueda. Cualquier otro filtro muestra la lista completa de ese filtro
      // (cada categoría tiene su propia cantidad — un "ver N más" global no aplica).
      const esVistaPorDefecto =
        listado === "mas-vendidos" && !categoria && !q && estado === "disponibles";
      let recortado = false;
      if (esVistaPorDefecto && !mostrandoTodos && totalCoincidencias > TOPE_MAS_VENDIDOS) {
        filtrados = filtrados.slice(0, TOPE_MAS_VENDIDOS);
        recortado = true;
      }

      renderTabla(filtrados, agrupado);

      document.getElementById("count-label").textContent =
        totalCoincidencias === 1 ? "1 producto" : `${totalCoincidencias} productos`;

      const row = document.getElementById("ver-todos-row");
      if (row) {
        row.hidden = !recortado;
        if (recortado) {
          document.getElementById("ver-todos-count").textContent = totalCoincidencias;
        }
      }
    }

    function mostrarTodos() {
      mostrandoTodos = true;
      filtrarTabla();
    }

    function ordenarPorListado(lista, listado) {
      const arr = [...lista];
      const porNuevo = (a, b) => (Number(b.id_producto) || 0) - (Number(a.id_producto) || 0);
      switch (listado) {
        case "mas-vendidos":
          // Más unidades vendidas primero; a igualdad, el más nuevo.
          return arr.sort((a, b) =>
            (Number(b.total_vendido) || 0) - (Number(a.total_vendido) || 0) || porNuevo(a, b)
          );
        case "az":
          return arr.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
        case "precio-asc":
          return arr.sort((a, b) => (Number(a.precio) || 0) - (Number(b.precio) || 0));
        case "precio-desc":
          return arr.sort((a, b) => (Number(b.precio) || 0) - (Number(a.precio) || 0));
        // "recientes" y "categoria" (el agrupado reordena por bloque después)
        default:
          return arr.sort(porNuevo);
      }
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
        <option value="">Todas las categorías</option>
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
          // Mostrar el nuevo al tope de su categoría: pasamos a la vista agrupada,
          // sin filtro de estado/categoría/texto que lo pueda esconder.
          idRecienCreado = creado?.id_producto ?? null;
          document.getElementById("listado-filter").value = "categoria";
          document.getElementById("estado-filter").value = "todos";
          document.getElementById("category-filter").value = "";
          document.getElementById("search-input").value = "";
          mostrandoTodos = false;
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
      todosLosProductos.forEach(p => { if (p.categoria) categorias.add(p.categoria); });
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
