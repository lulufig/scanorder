
    // Si ya hay sesión activa, redirigir directo al panel correspondiente
    if (isLoggedIn()) {
      const role = getUserRole();
      if (role === ROLES.ADMIN)      window.location.href = ROUTES.admin;
      else if (role === ROLES.MOZO)  window.location.href = ROUTES.mesas;
    }

    // Permitir enviar con Enter desde cualquier campo
    document.getElementById("email").addEventListener("keydown",    e => { if (e.key === "Enter") handleLogin(); });
    document.getElementById("password").addEventListener("keydown", e => { if (e.key === "Enter") handleLogin(); });

    function showError(msg) {
      const box = document.getElementById("error-box");
      document.getElementById("error-msg").textContent = msg;
      box.classList.add("visible");

      // Efecto shake en la card
      const card = document.getElementById("login-card");
      card.classList.remove("shake");
      void card.offsetWidth; // reflow para reiniciar animación
      card.classList.add("shake");
    }

    function hideError() {
      document.getElementById("error-box").classList.remove("visible");
    }

    function setLoading(loading) {
      const btn = document.getElementById("btn-login");
      if (loading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Verificando...';
      } else {
        btn.disabled = false;
        btn.innerHTML = 'Iniciar sesión';
      }
    }

    async function handleLogin() {
      const email    = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      hideError();

      // Validación básica en el cliente
      if (!email || !password) {
        showError("Completá los dos campos para continuar.");
        return;
      }
      if (!email.includes("@")) {
        showError("Ingresá un correo electrónico válido.");
        return;
      }

      setLoading(true);

      try {
        // POST /auth/login — sin token (auth=false)
        // El backend espera: { email, password }
        // Responde con: { access_token, token_type, user: { id_usuario, nombre, email, rol, activo } }
        const data = await fetchAPI("/auth/login", "POST", { email, password }, false);

        // Guardar token y datos del usuario
        saveToken(data.access_token);
        saveUser(data.user);

        // Primer login: el admin debe cambiar su contraseña
        if (data.user.must_change_password) {
          window.location.href = "/frontend/cambiar-password.html";
          return;
        }

        // Redirigir según rol
        if (data.user.rol === ROLES.ADMIN) {
          window.location.href = ROUTES.admin;
        } else if (data.user.rol === ROLES.MOZO) {
          window.location.href = ROUTES.mesas;
        } else {
          showError("Rol desconocido. Contactá al administrador.");
        }

      } catch (error) {
        // El backend devuelve 401 con detail: "Credenciales inválidas"
        if (error.status === 401) {
          showError("Email o contraseña incorrectos.");
        } else if (error.status === 0) {
          showError("No se pudo conectar con el servidor. Verificá la conexión.");
        } else {
          showError(error.message || "Ocurrió un error inesperado.");
        }
      } finally {
        setLoading(false);
      }
    }
  