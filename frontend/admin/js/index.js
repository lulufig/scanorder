
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    requireAuth(ROLES.ADMIN);

    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
      document.getElementById("welcome-nombre").textContent   = `Bienvenida, ${usuario.nombre} `;
    }

    // ── FECHAS POR DEFECTO (hoy) ─────────────────────────────────
    const hoy = new Date().toISOString().split("T")[0];
    document.getElementById("fecha-inicio").value = hoy;
    document.getElementById("fecha-fin").value    = hoy;
    cargarDashboard();
    cargarGraficoVentas();
    conectarNotificacionesAdmin();

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });
    let ventasChartData = [];
    let resizeChartTimer;

    async function cargarDashboard() {
      try {
        const data = await fetchAPI("/reportes/dashboard");
        document.getElementById("metric-ventas-hoy").textContent = formatPrecio(data.ventas_hoy);
        document.getElementById("metric-pedidos-hoy").textContent = data.pedidos_hoy;
        document.getElementById("metric-ticket").textContent = formatPrecio(data.ticket_promedio);
        document.getElementById("metric-mesas").textContent = data.mesas_activas;
        document.getElementById("metric-top").textContent = data.producto_top?.nombre || "-";
        document.getElementById("metric-top-help").textContent =
          data.producto_top?.cantidad ? `${data.producto_top.cantidad} vendidos hoy` : "Sin ventas hoy";
      } catch (error) {
        mostrarToast("No se pudieron cargar las métricas: " + error.message, "error");
      }
    }

    function conectarNotificacionesAdmin() {
      const token = getToken();
      if (!token) return;

      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      const socket = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?token=${encodeURIComponent(token)}`);

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "servicio_mesa") {
            mostrarToast(data.message || "Nueva solicitud de mesa", "success");
            reproducirAvisoAdmin();
            return;
          }
          if (data.type === "pedido_creado" || data.type === "pedido_actualizado") {
            cargarDashboard();
            if (!data.estado || ["confirmado", "en_preparacion", "listo", "entregado"].includes(data.estado)) {
              cargarGraficoVentas();
            }
          }
        } catch {
          cargarDashboard();
          cargarGraficoVentas();
        }
      });

      socket.addEventListener("close", () => {
        setTimeout(conectarNotificacionesAdmin, 4000);
      });
    }

    function reproducirAvisoAdmin() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 740;
        gain.gain.value = 0.04;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.16);
      } catch {
        // El navegador puede bloquear audio si no hubo interaccion previa.
      }
    }

    function formatPrecio(valor) {
      return formatterPrecio.format(Number(valor) || 0);
    }

    async function cargarGraficoVentas() {
      try {
        const data = await fetchAPI("/reportes/ventas-hoy");
        ventasChartData = data.serie || [];
        document.getElementById("chart-total").textContent = formatPrecio(data.total_ventas || 0);
        document.getElementById("chart-orders").textContent =
          `${Number(data.total_pedidos || 0)} pedidos confirmados`;
        renderGraficoVentas();
      } catch (error) {
        document.getElementById("chart-empty").textContent = "No se pudo cargar el gráfico de ventas.";
        document.getElementById("chart-empty").style.display = "grid";
      }
    }

    function renderGraficoVentas() {
      const canvas = document.getElementById("ventas-chart");
      const empty = document.getElementById("chart-empty");
      if (!canvas) return;

      const rect = canvas.parentElement.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = 260;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const data = ventasChartData.length ? ventasChartData : [];
      const maxVenta = Math.max(...data.map(item => Number(item.ventas) || 0), 0);
      empty.style.display = maxVenta > 0 ? "none" : "grid";

      const padding = { top: 20, right: 20, bottom: 42, left: 58 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;
      const barGap = 8;
      const barWidth = Math.max(12, (chartWidth - barGap * (data.length - 1)) / Math.max(data.length, 1));

      ctx.font = "700 11px Nunito, sans-serif";
      ctx.strokeStyle = "#E5E7EB";
      ctx.fillStyle = "#667085";
      ctx.lineWidth = 1;

      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        const value = maxVenta ? maxVenta - (maxVenta / 4) * i : 0;
        ctx.fillText(formatNumeroCompacto(value), 12, y + 4);
      }

      data.forEach((item, index) => {
        const x = padding.left + index * (barWidth + barGap);
        const value = Number(item.ventas) || 0;
        const barHeight = maxVenta ? Math.max(4, (value / maxVenta) * chartHeight) : 0;
        const y = padding.top + chartHeight - barHeight;

        const gradient = ctx.createLinearGradient(0, y, 0, padding.top + chartHeight);
        gradient.addColorStop(0, "#2563EB");
        gradient.addColorStop(1, "#93C5FD");

        ctx.fillStyle = value > 0 ? gradient : "#EEF2F7";
        roundRect(ctx, x, y, barWidth, barHeight || 4, 5);
        ctx.fill();

        if (index % 2 === 0) {
          ctx.fillStyle = "#667085";
          ctx.textAlign = "center";
          ctx.fillText(item.label.replace(":00", "h"), x + barWidth / 2, height - 16);
        }
      });

      ctx.textAlign = "left";
    }

    function roundRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
      ctx.closePath();
    }

    function formatNumeroCompacto(valor) {
      const numero = Number(valor) || 0;
      if (numero >= 1000000) return `$${(numero / 1000000).toFixed(1)}M`;
      if (numero >= 1000) return `$${Math.round(numero / 1000)}k`;
      return `$${Math.round(numero)}`;
    }

    window.addEventListener("resize", () => {
      clearTimeout(resizeChartTimer);
      resizeChartTimer = setTimeout(renderGraficoVentas, 120);
    });

    // ── ATAJOS DE FECHA ──────────────────────────────────────────
    function setAtajo(tipo) {
      const ahora  = new Date();
      let inicio, fin;

      if (tipo === "hoy") {
        inicio = fin = formatFecha(ahora);

      } else if (tipo === "semana") {
        const lunes  = new Date(ahora);
        lunes.setDate(ahora.getDate() - ((ahora.getDay() + 6) % 7));
        inicio = formatFecha(lunes);
        fin    = formatFecha(ahora);

      } else if (tipo === "mes") {
        inicio = formatFecha(new Date(ahora.getFullYear(), ahora.getMonth(), 1));
        fin    = formatFecha(ahora);

      } else if (tipo === "mes_anterior") {
        const primerDiaMesAnt = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
        const ultimoDiaMesAnt = new Date(ahora.getFullYear(), ahora.getMonth(), 0);
        inicio = formatFecha(primerDiaMesAnt);
        fin    = formatFecha(ultimoDiaMesAnt);
      }

      document.getElementById("fecha-inicio").value = inicio;
      document.getElementById("fecha-fin").value    = fin;
    }

    function formatFecha(date) {
      return date.toISOString().split("T")[0];
    }

    // ── GENERAR REPORTE DE VENTAS ────────────────────────────────
    async function generarReporteVentas() {
      const fechaInicio = document.getElementById("fecha-inicio").value;
      const fechaFin    = document.getElementById("fecha-fin").value;

      // Validaciones
      if (!fechaInicio || !fechaFin) {
        mostrarToast("Seleccioná ambas fechas para generar el reporte.", "error");
        return;
      }
      if (fechaInicio > fechaFin) {
        mostrarToast("La fecha de inicio no puede ser mayor a la fecha fin.", "error");
        return;
      }

      const btn = document.getElementById("btn-ventas");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Generando PDF...';

      try {
        // GET /reportes/ventas?fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
        // Devuelve un PDF — usamos downloadFile() de api.js
        const endpoint  = `/reportes/ventas?fecha_inicio=${fechaInicio}&fecha_fin=${fechaFin}`;
        const filename  = `reporte_ventas_${fechaInicio}_${fechaFin}.pdf`;

        await downloadFile(endpoint, filename);

        mostrarToast("Reporte descargado correctamente.", "success");
        agregarHistorial(filename, fechaInicio, fechaFin);

      } catch (error) {
        mostrarToast("Error al generar el reporte: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = "Generar reporte de ventas";
      }
    }

    // ── HISTORIAL DE DESCARGAS DE ESTA SESIÓN ───────────────────
    let historialItems = [];

    function agregarHistorial(filename, inicio, fin) {
      const ahora = new Date().toLocaleTimeString("es-AR", {
        hour: "2-digit", minute: "2-digit"
      });

      historialItems.unshift({ filename, inicio, fin, hora: ahora });

      // Máximo 5 items en el historial
      if (historialItems.length > 5) historialItems.pop();

      renderHistorial();
    }

    function renderHistorial() {
      const empty = document.getElementById("historial-ventas-empty");
      const lista = document.getElementById("historial-ventas-lista");

      if (historialItems.length === 0) {
        empty.style.display = "block";
        lista.innerHTML = "";
        return;
      }

      empty.style.display = "none";
      lista.innerHTML = historialItems.map(item => `
        <div class="historial-item">
          <div>
            <div class="historial-nombre"> ${item.inicio} → ${item.fin}</div>
          </div>
          <div class="historial-hora">Descargado ${item.hora}</div>
        </div>
      `).join("");
    }

    // ── TOAST ────────────────────────────────────────────────────
    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = mensaje;
      toast.className   = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }
  
