
    // Muestra la URL configurada en la UI
    document.getElementById("api-url-display").textContent = API_URL;

    function setStatus(ok, message) {
      const badge = document.getElementById("status-badge");
      const text  = document.getElementById("status-text");
      badge.className = `${ok ? "status-ok" : "status-error"} w-3 h-3 rounded-full inline-block`;
      text.textContent = message;
      text.style.color = ok ? "#16a34a" : "#dc2626";
    }

    function showResponse(data) {
      const box     = document.getElementById("response-box");
      const content = document.getElementById("response-content");
      content.textContent = JSON.stringify(data, null, 2);
      box.classList.remove("hidden");
    }

    // Prueba el endpoint público /health
    async function probarConexion() {
      const badge = document.getElementById("status-badge");
      badge.className = "status-loading w-3 h-3 rounded-full inline-block";
      document.getElementById("status-text").textContent = "Conectando...";
      document.getElementById("response-box").classList.add("hidden");

      try {
        const data = await fetchAPI("/health", "GET", null, false);
        setStatus(true, "✅ Backend conectado — /health OK");
        showResponse(data);
      } catch (error) {
        setStatus(false, `❌ ${error.message}`);
        showResponse({ error: error.message, codigo: error.status });
      }
    }

    // Prueba el endpoint protegido /auth/me (requiere token guardado)
    async function probarAuthMe() {
      const badge = document.getElementById("status-badge");
      badge.className = "status-loading w-3 h-3 rounded-full inline-block";
      document.getElementById("status-text").textContent = "Verificando token...";
      document.getElementById("response-box").classList.add("hidden");

      const token = getToken();
      if (!token) {
        setStatus(false, "❌ No hay token guardado. Hacé login primero.");
        showResponse({ hint: "Usá la página login.html para obtener un token." });
        return;
      }

      try {
        const data = await fetchAPI("/auth/me", "GET", null, true);
        setStatus(true, `✅ Token válido — Usuario: ${data.user?.nombre} (${data.user?.rol})`);
        showResponse(data);
      } catch (error) {
        setStatus(false, `❌ ${error.message}`);
        showResponse({ error: error.message, codigo: error.status });
      }
    }
  