    lucide.createIcons();
    requireAuth(ROLES.ADMIN);
    applyRoleVisibility();

    document.getElementById("sidebar-username").textContent = getUserNombre() || "—";

    // ── Datos ──────────────────────────────────────────────────────────────────

    let _usuarios = [];
    let _usuariosFiltrados = [];
    let _seleccionados = new Set();
    let _vistaUsuarios = "lista";
    let _sort = { campo: "created_at", dir: "desc" };

    async function cargarUsuarios() {
      try {
        _usuarios = await fetchAPI("/admin/usuarios");
        sincronizarOpcionesRol();
        renderTabla();
      } catch (e) {
        document.getElementById("tabla-body").innerHTML =
          `<tr><td colspan="6" class="empty-state">Error al cargar usuarios: ${e.message}</td></tr>`;
      }
    }

    function renderTabla() {
      const tbody = document.getElementById("tabla-body");
      _usuariosFiltrados = obtenerUsuariosVisibles();
      actualizarResumenUsuarios();
      limpiarSeleccionFueraDeVista();
      actualizarBulkBar();
      actualizarSelectAll();

      if (!_usuariosFiltrados.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No hay usuarios para los filtros aplicados.</td></tr>`;
        document.getElementById("users-grid").innerHTML = `<div class="empty-grid">No hay usuarios para mostrar.</div>`;
        document.getElementById("usuarios-count-label").textContent = "0 cuentas";
        return;
      }

      tbody.innerHTML = _usuariosFiltrados.map(u => `
        <tr class="${_seleccionados.has(u.id_usuario) ? "selected-row" : ""}">
          <td>
            <div class="user-profile">
              <input type="checkbox" class="user-select" onchange="toggleSeleccion(${u.id_usuario}, this.checked)" ${_seleccionados.has(u.id_usuario) ? "checked" : ""} />
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
          <td>${ultimoAccesoCell(u)}</td>
          <td>
            <div class="acciones-cell">
              <button class="btn-icon btn-editar" onclick="abrirModalEditar(${u.id_usuario})"
                title="Editar nombre, email o rol">
                <i data-lucide="pencil"></i>
              </button>
              <button class="btn-icon btn-reenviar" onclick="reenviarBienvenida(${u.id_usuario}, this)"
                title="Resetear contraseña y reenviar email"
                ${!u.activo ? "disabled" : ""}>
                <i data-lucide="key-round"></i>
              </button>
              <button class="switch-action ${u.activo ? 'on' : ''}"
                onclick="toggleActivo(${u.id_usuario}, this)"
                title="${u.activo ? 'Desactivar usuario' : 'Reactivar usuario'}">
                <span></span>
              </button>
            </div>
          </td>
        </tr>
      `).join("");

      renderGridUsuarios();
      lucide.createIcons();
    }

    function obtenerUsuariosVisibles() {
      const busqueda = normalizarTexto(document.getElementById("filtro-texto")?.value || "");
      const filtroListado = document.getElementById("filtro-listado")?.value || "recientes";
      const rol = document.getElementById("filtro-rol")?.value || "";
      const estadoFiltro = document.getElementById("filtro-estado")?.value || "";

      const usuariosBase = [..._usuarios]
        .filter(u => {
          const estado = estadoUsuario(u);
          const contenido = normalizarTexto(`${u.id_usuario} ${u.nombre || ""} ${u.email || ""} ${u.rol || ""}`);
          const pasaBusqueda = !busqueda || contenido.includes(busqueda);
          const pasaRol = !rol || String(u.rol || "") === rol;
          const pasaEstado = !estadoFiltro || estado === estadoFiltro;
          const pasaListado = filtrarPorListado(u, filtroListado);
          return pasaBusqueda && pasaRol && pasaEstado && pasaListado;
        });

      if (filtroListado === "recientes") {
        return usuariosBase.sort(compararPorCreacionDesc).slice(0, 5);
      }
      if (filtroListado === "antiguos") {
        return usuariosBase.sort(compararPorCreacionAsc);
      }
      if (filtroListado === "az") {
        return usuariosBase.sort((a, b) => normalizarTexto(a.nombre || "").localeCompare(normalizarTexto(b.nombre || ""), "es"));
      }
      if (filtroListado === "za") {
        return usuariosBase.sort((a, b) => normalizarTexto(b.nombre || "").localeCompare(normalizarTexto(a.nombre || ""), "es"));
      }
      return usuariosBase.sort(compararUsuarios);
    }

    function compararUsuarios(a, b) {
      const dir = _sort.dir === "asc" ? 1 : -1;
      const valorA = valorOrden(a, _sort.campo);
      const valorB = valorOrden(b, _sort.campo);
      if (valorA < valorB) return -1 * dir;
      if (valorA > valorB) return 1 * dir;
      return 0;
    }

    function valorOrden(u, campo) {
      if (campo === "estado") return estadoUsuario(u);
      if (campo === "ultimo_acceso") return new Date(u.ultimo_acceso || u.last_login || u.ultimo_login || u.created_at || 0).getTime();
      if (campo === "created_at") return fechaCreacionValor(u);
      return normalizarTexto(u[campo] || "");
    }

    function fechaCreacionValor(u) {
      const fecha = new Date(u.created_at || 0).getTime();
      return Number.isNaN(fecha) || !fecha ? Number(u.id_usuario || 0) : fecha;
    }

    function compararPorCreacionDesc(a, b) {
      return fechaCreacionValor(b) - fechaCreacionValor(a);
    }

    function compararPorCreacionAsc(a, b) {
      return fechaCreacionValor(a) - fechaCreacionValor(b);
    }

    function filtrarPorListado(u, filtro) {
      if (!filtro || ["todos", "recientes", "az", "za"].includes(filtro)) return true;
      if (filtro === "antiguos") return creadoHaceAlMenosMeses(u, 2);
      if (filtro === "temporal") return Boolean(u.debe_cambiar_password);
      return true;
    }

    function creadoHaceAlMenosMeses(u, meses) {
      const creado = new Date(u.created_at || 0);
      if (Number.isNaN(creado.getTime())) return false;
      const limite = new Date();
      limite.setMonth(limite.getMonth() - meses);
      return creado <= limite;
    }

    function ordenarPor(campo) {
      _sort = {
        campo,
        dir: _sort.campo === campo && _sort.dir === "asc" ? "desc" : "asc",
      };
      const filtroListado = document.getElementById("filtro-listado");
      if (filtroListado) filtroListado.value = "todos";
      renderTabla();
    }

    function actualizarFiltros() {
      renderTabla();
    }

    function cambiarVista(vista) {
      _vistaUsuarios = vista;
      document.querySelector(".usu-table-wrap").hidden = vista === "grid";
      document.getElementById("users-grid").hidden = vista !== "grid";
      document.getElementById("btn-view-list").classList.toggle("active", vista === "lista");
      document.getElementById("btn-view-grid").classList.toggle("active", vista === "grid");
      renderGridUsuarios();
      lucide.createIcons();
    }

    function renderGridUsuarios() {
      const grid = document.getElementById("users-grid");
      if (!grid) return;
      grid.innerHTML = _usuariosFiltrados.map(u => `
        <article class="user-card ${_seleccionados.has(u.id_usuario) ? "selected-card" : ""}">
          <div class="user-card-top">
            <input type="checkbox" class="user-select" onchange="toggleSeleccion(${u.id_usuario}, this.checked)" ${_seleccionados.has(u.id_usuario) ? "checked" : ""} />
            <span class="user-avatar">${inicialesUsuario(u.nombre)}</span>
            ${estadoBadge(u)}
          </div>
          <h3>${esc(u.nombre)}</h3>
          <p>${esc(u.email)}</p>
          <div class="card-meta">
            ${rolBadge(u.rol)}
            ${ultimoAccesoCell(u)}
          </div>
          <div class="acciones-cell">
            <button class="btn-icon btn-editar" onclick="abrirModalEditar(${u.id_usuario})" title="Editar"><i data-lucide="pencil"></i></button>
            <button class="btn-icon btn-reenviar" onclick="reenviarBienvenida(${u.id_usuario}, this)" title="Resetear contraseña" ${!u.activo ? "disabled" : ""}><i data-lucide="key-round"></i></button>
            <button class="switch-action ${u.activo ? 'on' : ''}" onclick="toggleActivo(${u.id_usuario}, this)" title="${u.activo ? 'Desactivar' : 'Reactivar'}"><span></span></button>
          </div>
        </article>
      `).join("");
    }

    function actualizarResumenUsuarios() {
      const total = _usuarios.length;
      const activos = _usuarios.filter(u => u.activo).length;
      const temporales = _usuarios.filter(u => u.activo && u.debe_cambiar_password).length;
      const inactivos = _usuarios.filter(u => !u.activo).length;
      document.getElementById("usuarios-total").textContent = total;
      document.getElementById("usuarios-activos").textContent = activos;
      document.getElementById("usuarios-temp").textContent = temporales;
      document.getElementById("usuarios-inactivos").textContent = inactivos;
      document.getElementById("usuarios-total-bar").style.width = "100%";
      document.getElementById("usuarios-activos-bar").style.width = `${porcentaje(activos, total)}%`;
      document.getElementById("usuarios-temp-bar").style.width = `${porcentaje(temporales, total)}%`;
      document.getElementById("usuarios-inactivos-bar").style.width = `${porcentaje(inactivos, total)}%`;
      document.getElementById("usuarios-count-label").textContent =
        _usuariosFiltrados.length === 1 ? "1 cuenta visible" : `${_usuariosFiltrados.length || total} cuentas visibles`;
    }

    function inicialesUsuario(nombre) {
      const partes = String(nombre || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      return partes.length
        ? partes.map(p => p[0]).join("").toUpperCase()
        : "—";
    }

    function rolBadge(rol) {
      const limpio = String(rol || "").trim();
      if (!limpio) return `<span class="role-badge role-empty">—</span>`;
      const label = limpio === "admin" ? "Administrador" : "Mozo";
      return `<span class="role-badge role-${esc(limpio)}">${esc(label)}</span>`;
    }

    function estadoUsuario(u) {
      if (!u.activo) return "inactivo";
      if (u.debe_cambiar_password) return "temporal";
      return "activo";
    }

    function estadoBadge(u) {
      if (!u.activo) return `<span class="status-badge status-inactivo"><span></span>Inactivo</span>`;
      if (u.debe_cambiar_password) return `<span class="status-badge status-temp"><span></span>Contraseña temporal</span>`;
      return `<span class="status-badge status-ok"><span></span>Activo</span>`;
    }

    function ultimoAccesoCell(u) {
      const valor = u.ultimo_acceso || u.last_login || u.ultimo_login;
      if (valor) return `<span class="last-access">${tiempoRelativo(valor)}</span>`;
      if (u.created_at) return `<span class="last-access muted">Añadido ${tiempoRelativo(u.created_at)}</span>`;
      return `<span class="last-access muted">Sin registro</span>`;
    }

    function tiempoRelativo(fecha) {
      const date = new Date(fecha);
      if (Number.isNaN(date.getTime())) return "Sin registro";
      const diffMs = Date.now() - date.getTime();
      const min = Math.floor(diffMs / 60000);
      if (min < 1) return "recién";
      if (min < 60) return `hace ${min} min`;
      const horas = Math.floor(min / 60);
      if (horas < 24) return `hace ${horas} h`;
      const dias = Math.floor(horas / 24);
      if (dias === 1) return "ayer";
      if (dias < 30) return `hace ${dias} días`;
      return date.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
    }

    function toggleSeleccion(id, checked) {
      if (checked) _seleccionados.add(id);
      else _seleccionados.delete(id);
      renderTabla();
    }

    function toggleSeleccionTodos(checked) {
      if (checked) _usuariosFiltrados.forEach(u => _seleccionados.add(u.id_usuario));
      else _usuariosFiltrados.forEach(u => _seleccionados.delete(u.id_usuario));
      renderTabla();
    }

    function limpiarSeleccionFueraDeVista() {
      const visibles = new Set(_usuariosFiltrados.map(u => u.id_usuario));
      _seleccionados = new Set([..._seleccionados].filter(id => visibles.has(id)));
    }

    function actualizarBulkBar() {
      const bulk = document.getElementById("bulk-bar");
      const count = _seleccionados.size;
      document.getElementById("selected-count").textContent = count;
      bulk.classList.toggle("visible", count > 0);
      const detalleBtn = document.getElementById("btn-detalle-seleccion");
      if (detalleBtn) {
        detalleBtn.disabled = count !== 1;
        detalleBtn.classList.toggle("is-ready", count === 1);
        detalleBtn.title = count === 1 ? "Ver detalles del usuario seleccionado" : "Seleccioná un usuario para ver sus detalles";
      }
      if (count !== 1) cerrarModalDetalles();
    }

    function actualizarSelectAll() {
      const selectAll = document.getElementById("select-all");
      if (!selectAll) return;
      const visibles = _usuariosFiltrados.map(u => u.id_usuario);
      const seleccionadosVisibles = visibles.filter(id => _seleccionados.has(id)).length;
      selectAll.checked = visibles.length > 0 && seleccionadosVisibles === visibles.length;
      selectAll.indeterminate = seleccionadosVisibles > 0 && seleccionadosVisibles < visibles.length;
    }

    function exportarSeleccionCSV() {
      const usuarios = _usuarios.filter(u => _seleccionados.has(u.id_usuario));
      if (!usuarios.length) return;
      const filas = [
        ["ID", "Nombre", "Email", "Rol", "Estado", "Ultimo acceso"],
        ...usuarios.map(u => [
          u.id_usuario,
          u.nombre,
          u.email,
          u.rol,
          estadoUsuario(u),
          u.ultimo_acceso || u.last_login || u.ultimo_login || "",
        ]),
      ];
      const csv = filas.map(row => row.map(valor => `"${String(valor ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "usuarios_seleccionados.csv";
      a.click();
      URL.revokeObjectURL(url);
    }

    function abrirDetalleSeleccionado() {
      if (_seleccionados.size !== 1) {
        showToast("Seleccioná un solo usuario para ver sus detalles.", "error");
        return;
      }
      abrirModalDetalles([..._seleccionados][0]);
    }

    function abrirModalDetalles(id) {
      const usuario = _usuarios.find(u => u.id_usuario === id);
      if (!usuario) {
        showToast("No se encontró el usuario seleccionado.", "error");
        return;
      }

      const content = document.getElementById("detalle-usuario-content");
      content.innerHTML = `
        <div class="detail-profile">
          ${fotoUsuario(usuario)}
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
          ${detalleItem("Último acceso", fechaCompleta(usuario.ultimo_acceso || usuario.last_login || usuario.ultimo_login))}
          ${detalleItem("Creado", fechaCompleta(usuario.created_at))}
        </div>
      `;
      document.getElementById("user-detail-pane").classList.add("open");
      lucide.createIcons();
    }

    function cerrarModalDetalles() {
      document.getElementById("user-detail-pane")?.classList.remove("open");
    }

    function detalleItem(label, value) {
      return `
        <div class="detail-item">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
        </div>
      `;
    }

    function fotoUsuario(usuario) {
      const src = usuario.foto_url || usuario.foto || usuario.avatar_url || usuario.imagen || "";
      if (src) {
        return `<img class="detail-avatar-img" src="${esc(src)}" alt="Foto de ${esc(usuario.nombre || "usuario")}">`;
      }
      return `<span class="detail-avatar">${inicialesUsuario(usuario.nombre)}</span>`;
    }

    function rolTexto(rol) {
      const limpio = String(rol || "").trim();
      if (!limpio) return "-";
      return limpio === "admin" ? "Administrador" : "Mozo";
    }

    function estadoTexto(usuario) {
      if (!usuario.activo) return "Inactivo";
      if (usuario.debe_cambiar_password) return "Contraseña temporal";
      return "Activo";
    }

    function fechaCompleta(valor) {
      if (!valor) return "Sin registro";
      const fecha = new Date(valor);
      if (Number.isNaN(fecha.getTime())) return "Sin registro";
      return fecha.toLocaleString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
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
      const ids = [..._seleccionados];
      if (!ids.length) return;
      const rolNormalizado = document.getElementById("bulk-rol").value;
      if (!["admin", "mozo"].includes(rolNormalizado)) {
        showToast("Rol inválido. Usá admin o mozo.", "error");
        return;
      }

      const btn = document.getElementById("btn-bulk-rol-confirm");
      btn.disabled = true;
      btn.textContent = "Aplicando...";

      try {
        await Promise.all(ids.map(id => {
          const u = _usuarios.find(x => x.id_usuario === id);
          if (!u) return Promise.resolve();
          return fetchAPI(`/admin/usuarios/${id}`, "PUT", {
            nombre: u.nombre,
            email: u.email,
            rol: rolNormalizado,
          });
        }));
        _usuarios.forEach(u => {
          if (_seleccionados.has(u.id_usuario)) u.rol = rolNormalizado;
        });
        _seleccionados.clear();
        cerrarModalCambiarRol();
        renderTabla();
        showToast("Rol actualizado para los usuarios seleccionados.", "ok");
      } catch (e) {
        showToast(e.message || "No se pudo cambiar el rol.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Aplicar cambios";
      }
    }

    async function desactivarSeleccionados() {
      const usuarios = _usuarios.filter(u => _seleccionados.has(u.id_usuario) && u.activo);
      if (!usuarios.length) {
        showToast("Los usuarios seleccionados ya están inactivos.", "error");
        return;
      }
      if (!confirm(`¿Desactivar ${usuarios.length} usuario(s) seleccionado(s)?`)) return;

      try {
        await Promise.all(usuarios.map(u => fetchAPI(`/admin/usuarios/${u.id_usuario}/activo`, "PATCH")));
        usuarios.forEach(u => { u.activo = false; });
        _seleccionados.clear();
        renderTabla();
        showToast("Usuarios desactivados correctamente.", "ok");
      } catch (e) {
        showToast(e.message || "No se pudieron desactivar los usuarios.", "error");
      }
    }

    function sincronizarOpcionesRol() {
      // El backend actual solo acepta admin y mozo. Mantenerlo sincronizado evita
      // mostrar roles que luego la API rechaza.
      ["m-rol", "e-rol"].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = `
          <option value="mozo">Mozo</option>
          <option value="admin">Administrador</option>
        `;
      });
    }

    function porcentaje(valor, total) {
      if (!total) return 0;
      return Math.max(4, Math.round((valor / total) * 100));
    }

    function normalizarTexto(texto) {
      return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // ── Crear usuario ──────────────────────────────────────────────────────────

    function abrirModalCrear() {
      document.getElementById("m-nombre").value = "";
      document.getElementById("m-email").value  = "";
      document.getElementById("m-rol").value    = "mozo";
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
        const nuevo = await fetchAPI("/admin/usuarios", "POST", { nombre, email, rol });
        _usuarios.unshift(nuevo);
        renderTabla();
        cerrarModal();
        showToast("Usuario creado. Se envió el email de bienvenida.", "ok");
      } catch (e) {
        errEl.textContent = e.message || "No se pudo crear el usuario.";
        errEl.classList.add("visible");
      } finally {
        btn.disabled = false;
        btn.textContent = "Crear usuario";
      }
    }

    // ── Editar usuario ─────────────────────────────────────────────────────────

    let _editandoId = null;

    function abrirModalEditar(id) {
      const u = _usuarios.find(x => x.id_usuario === id);
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
        const actualizado = await fetchAPI(`/admin/usuarios/${_editandoId}`, "PUT", { nombre, email, rol });
        const idx = _usuarios.findIndex(x => x.id_usuario === _editandoId);
        if (idx !== -1) _usuarios[idx] = { ..._usuarios[idx], ...actualizado };
        renderTabla();
        cerrarModalEditar();
        showToast("Usuario actualizado.", "ok");
      } catch (e) {
        errEl.textContent = e.message || "No se pudo actualizar el usuario.";
        errEl.classList.add("visible");
      } finally {
        btn.disabled = false;
        btn.textContent = "Guardar cambios";
      }
    }

    // ── Desactivar / Reactivar ────────────────────────────────────────────────

    async function toggleActivo(id, btnEl) {
      const desactivando = btnEl.classList.contains("desactivar");
      btnEl.disabled = true;
      btnEl.classList.add("loading");
      try {
        const res = await fetchAPI(`/admin/usuarios/${id}/activo`, "PATCH");
        const u = _usuarios.find(x => x.id_usuario === id);
        if (u) u.activo = res.activo;
        renderTabla();
        showToast(res.activo ? "Usuario reactivado." : "Usuario desactivado.", "ok");
      } catch (e) {
        showToast(e.message || "Error al cambiar estado.", "error");
        btnEl.disabled = false;
        btnEl.classList.remove("loading");
      }
    }

    // ── Reenviar bienvenida ────────────────────────────────────────────────────

    async function reenviarBienvenida(id, btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add("loading");
      try {
        await fetchAPI(`/admin/usuarios/${id}/reenviar-bienvenida`, "POST");
        showToast("Email de bienvenida reenviado.", "ok");
        // Marcar el usuario como "contraseña temporal" localmente
        const u = _usuarios.find(x => x.id_usuario === id);
        if (u) u.debe_cambiar_password = true;
        renderTabla();
      } catch (e) {
        showToast(e.message || "Error al reenviar.", "error");
        btnEl.disabled = false;
        btnEl.classList.remove("loading");
      }
    }

    // ── Toast ──────────────────────────────────────────────────────────────────

    let _toastTimer = null;
    function showToast(msg, tipo = "ok") {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.className = `toast toast-${tipo} visible`;
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => t.classList.remove("visible"), 3500);
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    cargarUsuarios();
