
    requireAuth(ROLES.ADMIN);

    document.getElementById("sidebar-username").textContent = getUserNombre() || "—";

    // ── Datos ──────────────────────────────────────────────────────────────────

    let _usuarios = [];

    async function cargarUsuarios() {
      try {
        _usuarios = await fetchAPI("/admin/usuarios");
        renderTabla();
      } catch (e) {
        document.getElementById("tabla-body").innerHTML =
          `<tr><td colspan="5" class="empty-state">Error al cargar usuarios: ${e.message}</td></tr>`;
      }
    }

    function renderTabla() {
      const tbody = document.getElementById("tabla-body");
      if (!_usuarios.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No hay usuarios registrados.</td></tr>`;
        return;
      }
      tbody.innerHTML = _usuarios.map(u => `
        <tr>
          <td><span class="usuario-nombre">${esc(u.nombre)}</span></td>
          <td><span class="usuario-email">${esc(u.email)}</span></td>
          <td><span class="role-badge">${labelRol(u.rol)}</span></td>
          <td>${estadoBadge(u)}</td>
          <td>
            <div class="acciones-cell">
              <button class="action-btn" onclick="abrirModalEditar(${u.id_usuario})"
                title="Editar usuario" aria-label="Editar usuario">
                <span aria-hidden="true">✎</span>
              </button>
              <button class="action-btn action-mail" onclick="reenviarBienvenida(${u.id_usuario}, this)"
                title="Genera nueva contraseña temporal y reenvía el email"
                aria-label="Reenviar bienvenida"
                ${!u.activo ? "disabled" : ""}>
                <span aria-hidden="true">✉</span>
              </button>
              <button class="action-btn action-toggle ${u.activo ? 'desactivar' : 'activar'}"
                onclick="toggleActivo(${u.id_usuario}, this)"
                title="${u.activo ? 'Desactivar usuario' : 'Reactivar usuario'}"
                aria-label="${u.activo ? 'Desactivar usuario' : 'Reactivar usuario'}">
                <span aria-hidden="true">${u.activo ? "⏻" : "▷"}</span>
              </button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function estadoBadge(u) {
      if (!u.activo) return `<span class="status-badge status-inactivo"><span class="status-dot"></span>Inactivo</span>`;
      if (u.debe_cambiar_password) return `<span class="status-badge status-temp"><span class="status-dot"></span>Contraseña temporal</span>`;
      return `<span class="status-badge status-ok"><span class="status-dot"></span>Activo</span>`;
    }

    function labelRol(rol) {
      if (!rol) return "—";

      const labels = {
        admin: "Administrador",
        mozo: "Mozo",
      };
      return labels[rol] || rol;
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
      if (e.key === "Escape") { cerrarModal(); cerrarModalEditar(); }
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
      btnEl.classList.add("is-loading");
      try {
        const res = await fetchAPI(`/admin/usuarios/${id}/activo`, "PATCH");
        const u = _usuarios.find(x => x.id_usuario === id);
        if (u) u.activo = res.activo;
        renderTabla();
        showToast(res.activo ? "Usuario reactivado." : "Usuario desactivado.", "ok");
      } catch (e) {
        showToast(e.message || "Error al cambiar estado.", "error");
        renderTabla();
      }
    }

    // ── Reenviar bienvenida ────────────────────────────────────────────────────

    async function reenviarBienvenida(id, btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add("is-loading");
      try {
        await fetchAPI(`/admin/usuarios/${id}/reenviar-bienvenida`, "POST");
        showToast("Email de bienvenida reenviado.", "ok");
        // Marcar el usuario como "contraseña temporal" localmente
        const u = _usuarios.find(x => x.id_usuario === id);
        if (u) u.debe_cambiar_password = true;
        renderTabla();
      } catch (e) {
        showToast(e.message || "Error al reenviar.", "error");
        renderTabla();
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
  
