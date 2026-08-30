    lucide.createIcons();
    requireAuth(ROLES.ADMIN);
    applyRoleVisibility();

    document.getElementById("sidebar-username").textContent = getUserNombre() || "—";

    // ── Estado ─────────────────────────────────────────────────────────────────
    let _pageItems = [];              // usuarios de la página actual
    let _resumen = {};                // contadores globales
    let _seleccionados = new Map();   // id_usuario -> usuario (persiste entre páginas)
    let _paginaActual = 1;
    let _debounce = null;
    let _editandoId = null;
    const LIMITE_PAGINA = 15;
    const LIMITE_RESUMEN = 5;

    // ── Carga (server-side) ────────────────────────────────────────────────────
    function modoResumen() {
      return document.getElementById("filtro-listado").value === "resumen";
    }

    function paramsUsuarios() {
      const p = new URLSearchParams();
      const resumen = modoResumen();
      p.set("page", resumen ? 1 : _paginaActual);
      p.set("limit", resumen ? LIMITE_RESUMEN : LIMITE_PAGINA);
      const q = document.getElementById("filtro-texto").value.trim();
      if (q) p.set("q", q);
      const rol = document.getElementById("filtro-rol").value;
      if (rol) p.set("rol", rol);
      const estado = document.getElementById("filtro-estado").value;
      if (estado) p.set("estado", estado);
      p.set("orden", resumen ? "recientes" : document.getElementById("filtro-listado").value);
      return p.toString();
    }

    async function cargarUsuarios() {
      try {
        const data = await fetchAPI(`/admin/usuarios?${paramsUsuarios()}`);

        if (!modoResumen() && data.pages && _paginaActual > data.pages) {
          _paginaActual = data.pages;
          return cargarUsuarios();
        }

        _pageItems = Array.isArray(data.items) ? data.items : [];
        _resumen = data.resumen || {};
        sincronizarOpcionesRol();
        actualizarResumen();
        renderTabla();

        const paginador = document.getElementById("paginador");
        if (modoResumen()) {
          paginador.hidden = true;
          paginador.innerHTML = "";
        } else {
          renderPaginador("paginador", {
            page: data.page, pages: data.pages, total: data.total, limit: data.limit,
            onPage: (n) => { _paginaActual = n; cargarUsuarios(); window.scrollTo({ top: 0, behavior: "smooth" }); },
          });
        }
      } catch (e) {
        document.getElementById("tabla-body").innerHTML =
          `<tr><td colspan="6" class="empty-state">Error al cargar usuarios: ${esc(e.message)}</td></tr>`;
      }
    }

    function onFiltroChange() {
      _paginaActual = 1;
      cargarUsuarios();
    }

    function onBusquedaInput() {
      clearTimeout(_debounce);
      _debounce = setTimeout(() => { _paginaActual = 1; cargarUsuarios(); }, 300);
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    function renderTabla() {
      const tbody = document.getElementById("tabla-body");
      actualizarBulkBar();
      actualizarSelectAll();

      document.getElementById("usuarios-count-label").textContent =
        _resumen.total === 1 ? "1 cuenta" : `${_resumen.total ?? "—"} cuentas`;

      if (!_pageItems.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No hay usuarios para los filtros aplicados.</td></tr>`;
        return;
      }

      tbody.innerHTML = _pageItems.map(u => `
        <tr class="${_seleccionados.has(u.id_usuario) ? "selected-row" : ""}">
          <td>
            <div class="user-profile">
              <input type="checkbox" class="user-select" onchange="toggleSeleccion(${u.id_usuario}, this.checked)"
                ${_seleccionados.has(u.id_usuario) ? "checked" : ""} aria-label="Seleccionar ${esc(u.nombre)}" />
              <span class="user-avatar">${inicialesUsuario(u.nombre)}</span>
              <span>
                <strong>${esc(u.nombre)}</strong>
                <small>ID #${u.id_usuario}</small>
              </span>
            </div>
          </td>
          <td class="email-cell">${esc(u.email)}</td>
          <td>${rolBadge(u.rol)}</td>
          <td>${estadoBadge(u)}</td>
          <td>${agregadoCell(u)}</td>
          <td>
            <div class="acciones-cell">
              <button class="btn-edit" onclick="abrirModalEditar(${u.id_usuario})">Editar</button>
              <button class="btn-edit" onclick="reenviarBienvenida(${u.id_usuario}, this)" ${!u.activo ? "disabled" : ""}>Reenviar</button>
              <button class="switch-action ${u.activo ? "on" : ""}" onclick="toggleActivo(${u.id_usuario}, this)"
                title="${u.activo ? "Desactivar usuario" : "Reactivar usuario"}"><span></span></button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function actualizarResumen() {
      document.getElementById("usuarios-total").textContent      = _resumen.total ?? "—";
      document.getElementById("usuarios-activos").textContent    = _resumen.activos ?? "—";
      document.getElementById("usuarios-temp").textContent       = _resumen.temporales ?? "—";
      document.getElementById("usuarios-inactivos").textContent  = _resumen.inactivos ?? "—";
    }

    function inicialesUsuario(nombre) {
      const partes = String(nombre || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      return partes.length ? partes.map(p => p[0]).join("").toUpperCase() : "—";
    }

    function rolBadge(rol) {
      const limpio = String(rol || "").trim();
      if (!limpio) return `<span class="role-badge role-empty">—</span>`;
      const label = limpio === "admin" ? "Administrador" : "Mozo";
      return `<span class="role-badge role-${esc(limpio)}">${esc(label)}</span>`;
    }

    function estadoBadge(u) {
      if (!u.activo) return `<span class="status-badge status-inactivo"><span></span>Inactivo</span>`;
      if (u.debe_cambiar_password) return `<span class="status-badge status-temp"><span></span>Contraseña temporal</span>`;
      return `<span class="status-badge status-ok"><span></span>Activo</span>`;
    }

    function agregadoCell(u) {
      if (u.created_at) return `<span class="last-access">${tiempoRelativo(u.created_at)}</span>`;
      return `<span class="last-access muted">Sin registro</span>`;
    }

    function tiempoRelativo(fecha) {
      const date = new Date(fecha);
      if (Number.isNaN(date.getTime())) return "Sin registro";
      const min = Math.floor((Date.now() - date.getTime()) / 60000);
      if (min < 1) return "recién";
      if (min < 60) return `hace ${min} min`;
      const horas = Math.floor(min / 60);
      if (horas < 24) return `hace ${horas} h`;
      const dias = Math.floor(horas / 24);
      if (dias === 1) return "ayer";
      if (dias < 30) return `hace ${dias} días`;
      return date.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
    }

    // ── Selección (persiste entre páginas) ─────────────────────────────────────
    function toggleSeleccion(id, checked) {
      if (checked) {
        const u = _pageItems.find(x => x.id_usuario === id);
        if (u) _seleccionados.set(id, u);
      } else {
        _seleccionados.delete(id);
      }
      renderTabla();
    }

    function toggleSeleccionTodos(checked) {
      _pageItems.forEach(u => {
        if (checked) _seleccionados.set(u.id_usuario, u);
        else _seleccionados.delete(u.id_usuario);
      });
      renderTabla();
    }

    function actualizarBulkBar() {
      const bulk = document.getElementById("bulk-bar");
      const count = _seleccionados.size;
      document.getElementById("selected-count").textContent = count;
      bulk.classList.toggle("visible", count > 0);
      const detalleBtn = document.getElementById("btn-detalle-seleccion");
      detalleBtn.disabled = count !== 1;
      if (count !== 1) cerrarModalDetalles();
    }

    function actualizarSelectAll() {
      const selectAll = document.getElementById("select-all");
      if (!selectAll) return;
      const visibles = _pageItems.map(u => u.id_usuario);
      const marcados = visibles.filter(id => _seleccionados.has(id)).length;
      selectAll.checked = visibles.length > 0 && marcados === visibles.length;
      selectAll.indeterminate = marcados > 0 && marcados < visibles.length;
    }

    // ── Acciones en lote ──────────────────────────────────────────────────────
    function exportarSeleccionCSV() {
      const usuarios = [..._seleccionados.values()];
      if (!usuarios.length) return;
      const filas = [
        ["ID", "Nombre", "Email", "Rol", "Estado", "Creado"],
        ...usuarios.map(u => [
          u.id_usuario, u.nombre, u.email, u.rol, estadoTexto(u), u.created_at || "",
        ]),
      ];
      const csv = filas.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "usuarios_seleccionados.csv";
      a.click();
      URL.revokeObjectURL(url);
    }

    function abrirModalCambiarRol() {
      if (!_seleccionados.size) return;
      document.getElementById("bulk-role-count").textContent = _seleccionados.size;
      document.getElementById("bulk-rol").value = "mozo";
      document.getElementById("btn-bulk-rol-confirm").disabled = false;
      document.getElementById("modal-cambiar-rol").classList.add("open");
    }

    function cerrarModalCambiarRol() {
      document.getElementById("modal-cambiar-rol").classList.remove("open");
    }

    document.getElementById("modal-cambiar-rol").addEventListener("click", e => {
      if (e.target === e.currentTarget) cerrarModalCambiarRol();
    });

    async function cambiarRolSeleccionados() {
      const usuarios = [..._seleccionados.values()];
      if (!usuarios.length) return;
      const rol = document.getElementById("bulk-rol").value;
      if (!["admin", "mozo"].includes(rol)) {
        showToast("Rol inválido. Usá admin o mozo.", "error");
        return;
      }

      const btn = document.getElementById("btn-bulk-rol-confirm");
      btn.disabled = true;
      btn.textContent = "Aplicando...";
      try {
        await Promise.all(usuarios.map(u =>
          fetchAPI(`/admin/usuarios/${u.id_usuario}`, "PUT", { nombre: u.nombre, email: u.email, rol })
        ));
        _seleccionados.clear();
        cerrarModalCambiarRol();
        await cargarUsuarios();
        showToast("Rol actualizado para los usuarios seleccionados.", "ok");
      } catch (e) {
        showToast(e.message || "No se pudo cambiar el rol.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Aplicar cambios";
      }
    }

    async function desactivarSeleccionados() {
      const usuarios = [..._seleccionados.values()].filter(u => u.activo);
      if (!usuarios.length) {
        showToast("Los usuarios seleccionados ya están inactivos.", "error");
        return;
      }
      if (!confirm(`¿Desactivar ${usuarios.length} usuario(s) seleccionado(s)?`)) return;
      try {
        await Promise.all(usuarios.map(u => fetchAPI(`/admin/usuarios/${u.id_usuario}/activo`, "PATCH")));
        _seleccionados.clear();
        await cargarUsuarios();
        showToast("Usuarios desactivados correctamente.", "ok");
      } catch (e) {
        showToast(e.message || "No se pudieron desactivar los usuarios.", "error");
      }
    }

    // ── Panel de detalles ─────────────────────────────────────────────────────
    function abrirDetalleSeleccionado() {
      if (_seleccionados.size !== 1) {
        showToast("Seleccioná un solo usuario para ver sus detalles.", "error");
        return;
      }
      const usuario = [..._seleccionados.values()][0];
      const content = document.getElementById("detalle-usuario-content");
      content.innerHTML = `
        <div class="detail-profile">
          <span class="detail-avatar">${inicialesUsuario(usuario.nombre)}</span>
          <div>
            <span class="detail-kicker">Ficha de usuario</span>
            <h3>${esc(usuario.nombre || "Sin nombre")}</h3>
            <div class="detail-badges">
              ${rolBadge(usuario.rol)}
              ${estadoBadge(usuario)}
            </div>
          </div>
        </div>

        <div class="detail-grid">
          ${detalleItem("ID de usuario", `#${usuario.id_usuario || "-"}`)}
          ${detalleItem("Correo", usuario.email || "-")}
          ${detalleItem("Rol", rolTexto(usuario.rol))}
          ${detalleItem("Estado", estadoTexto(usuario))}
          ${detalleItem("Creado", fechaCompleta(usuario.created_at))}
        </div>
      `;
      document.getElementById("user-detail-pane").classList.add("open");
    }

    function cerrarModalDetalles() {
      document.getElementById("user-detail-pane")?.classList.remove("open");
    }

    function detalleItem(label, value) {
      return `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    }

    function rolTexto(rol) {
      const limpio = String(rol || "").trim();
      if (!limpio) return "-";
      return limpio === "admin" ? "Administrador" : "Mozo";
    }

    function estadoTexto(u) {
      if (!u.activo) return "Inactivo";
      if (u.debe_cambiar_password) return "Contraseña temporal";
      return "Activo";
    }

    function fechaCompleta(valor) {
      if (!valor) return "Sin registro";
      const fecha = new Date(valor);
      if (Number.isNaN(fecha.getTime())) return "Sin registro";
      return fecha.toLocaleString("es-AR", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
    }

    // ── Crear / editar / estado ───────────────────────────────────────────────
    function sincronizarOpcionesRol() {
      ["m-rol", "e-rol"].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = `<option value="mozo">Mozo</option><option value="admin">Administrador</option>`;
      });
    }

    function abrirModalCrear() {
      document.getElementById("m-nombre").value = "";
      document.getElementById("m-email").value = "";
      document.getElementById("m-rol").value = "mozo";
      document.getElementById("modal-error").classList.remove("visible");
      document.getElementById("btn-crear-confirm").disabled = false;
      document.getElementById("modal-crear").classList.add("open");
      setTimeout(() => document.getElementById("m-nombre").focus(), 50);
    }

    function cerrarModal() {
      document.getElementById("modal-crear").classList.remove("open");
    }

    document.getElementById("modal-crear").addEventListener("click", e => {
      if (e.target === e.currentTarget) cerrarModal();
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { cerrarModal(); cerrarModalEditar(); cerrarModalCambiarRol(); }
    });

    async function crearUsuario() {
      const nombre = document.getElementById("m-nombre").value.trim();
      const email  = document.getElementById("m-email").value.trim();
      const rol    = document.getElementById("m-rol").value;
      const errEl  = document.getElementById("modal-error");
      errEl.classList.remove("visible");

      if (!nombre) { errEl.textContent = "El nombre es obligatorio."; errEl.classList.add("visible"); return; }
      if (!email || !email.includes("@")) { errEl.textContent = "Ingresá un email válido."; errEl.classList.add("visible"); return; }

      const btn = document.getElementById("btn-crear-confirm");
      btn.disabled = true;
      btn.textContent = "Creando...";
      try {
        await fetchAPI("/admin/usuarios", "POST", { nombre, email, rol });
        cerrarModal();
        // Ver el nuevo: orden recientes, página 1, sin filtros.
        document.getElementById("filtro-listado").value = "recientes";
        document.getElementById("filtro-rol").value = "";
        document.getElementById("filtro-estado").value = "";
        document.getElementById("filtro-texto").value = "";
        _paginaActual = 1;
        await cargarUsuarios();
        showToast("Usuario creado. Se envió el email de bienvenida.", "ok");
      } catch (e) {
        errEl.textContent = e.message || "No se pudo crear el usuario.";
        errEl.classList.add("visible");
      } finally {
        btn.disabled = false;
        btn.textContent = "Crear usuario";
      }
    }

    function abrirModalEditar(id) {
      const u = _pageItems.find(x => x.id_usuario === id) || _seleccionados.get(id);
      if (!u) return;
      _editandoId = id;
      document.getElementById("e-nombre").value = u.nombre;
      document.getElementById("e-email").value  = u.email;
      document.getElementById("e-rol").value    = u.rol;
      document.getElementById("modal-editar-error").classList.remove("visible");
      document.getElementById("btn-editar-confirm").disabled = false;
      document.getElementById("btn-editar-confirm").textContent = "Guardar cambios";
      document.getElementById("modal-editar").classList.add("open");
      setTimeout(() => document.getElementById("e-nombre").focus(), 50);
    }

    function cerrarModalEditar() {
      document.getElementById("modal-editar").classList.remove("open");
      _editandoId = null;
    }

    document.getElementById("modal-editar").addEventListener("click", e => {
      if (e.target === e.currentTarget) cerrarModalEditar();
    });

    async function guardarEdicion() {
      const nombre = document.getElementById("e-nombre").value.trim();
      const email  = document.getElementById("e-email").value.trim();
      const rol    = document.getElementById("e-rol").value;
      const errEl  = document.getElementById("modal-editar-error");
      errEl.classList.remove("visible");

      if (!nombre) { errEl.textContent = "El nombre es obligatorio."; errEl.classList.add("visible"); return; }
      if (!email || !email.includes("@")) { errEl.textContent = "Ingresá un email válido."; errEl.classList.add("visible"); return; }

      const btn = document.getElementById("btn-editar-confirm");
      btn.disabled = true;
      btn.textContent = "Guardando...";
      try {
        await fetchAPI(`/admin/usuarios/${_editandoId}`, "PUT", { nombre, email, rol });
        _seleccionados.delete(_editandoId);
        cerrarModalEditar();
        await cargarUsuarios();
        showToast("Usuario actualizado.", "ok");
      } catch (e) {
        errEl.textContent = e.message || "No se pudo actualizar el usuario.";
        errEl.classList.add("visible");
      } finally {
        btn.disabled = false;
        btn.textContent = "Guardar cambios";
      }
    }

    async function toggleActivo(id, btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add("loading");
      try {
        const res = await fetchAPI(`/admin/usuarios/${id}/activo`, "PATCH");
        _seleccionados.delete(id);
        await cargarUsuarios();
        showToast(res.activo ? "Usuario reactivado." : "Usuario desactivado.", "ok");
      } catch (e) {
        showToast(e.message || "Error al cambiar estado.", "error");
        btnEl.disabled = false;
        btnEl.classList.remove("loading");
      }
    }

    async function reenviarBienvenida(id, btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add("loading");
      try {
        await fetchAPI(`/admin/usuarios/${id}/reenviar-bienvenida`, "POST");
        await cargarUsuarios();
        showToast("Email de bienvenida reenviado.", "ok");
      } catch (e) {
        showToast(e.message || "Error al reenviar.", "error");
        btnEl.disabled = false;
        btnEl.classList.remove("loading");
      }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    let _toastTimer = null;
    function showToast(msg, tipo = "ok") {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.className = `toast toast-${tipo} visible`;
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => t.classList.remove("visible"), 3500);
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    cargarUsuarios();
