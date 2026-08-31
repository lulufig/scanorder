
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    if (!requireAuth(ROLES.ADMIN)) throw new Error();
    applyRoleVisibility();

    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
      const welcomeNombre = document.getElementById("welcome-nombre");
      if (welcomeNombre) welcomeNombre.textContent = `Bienvenida, ${usuario.nombre} `;
    }

    const tieneDashboard = Boolean(document.getElementById("ventas-chart"));
    const tieneReportes = Boolean(document.getElementById("fecha-inicio"));

    // ── FECHAS POR DEFECTO (hoy) ─────────────────────────────────
    const hoy = new Date().toISOString().split("T")[0];
    if (tieneReportes) {
      document.getElementById("fecha-inicio").value = hoy;
      document.getElementById("fecha-fin").value = hoy;
      const fechaResumen = document.getElementById("fecha-resumen");
      if (fechaResumen) fechaResumen.value = hoy;
    }

    if (tieneDashboard) {
      cargarDashboard();
      cargarAlertaStock();
      cargarGraficoVentas();
      cargarVentasSemana();
      conectarNotificacionesAdmin();
    }

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });
    const META_VENTAS_DIARIA = 120000;
    let ventasChartData = [];

    async function cargarDashboard() {
      try {
        const data = await fetchAPI("/reportes/dashboard");
        document.getElementById("metric-ventas-hoy").textContent = formatPrecio(data.ventas_hoy);
        document.getElementById("metric-pedidos-hoy").textContent = data.pedidos_hoy;
        document.getElementById("metric-ticket").textContent = formatPrecio(data.ticket_promedio);

        const activos = data.pedidos_activos || {};
        const totalActivos = (Number(activos.pendiente) || 0)
          + (Number(activos.confirmado) || 0)
          + (Number(activos.en_preparacion) || 0)
          + (Number(activos.listo) || 0);
        document.getElementById("metric-activos").textContent = totalActivos;

        // Comparación vs. el día anterior: el backend todavía no expone estos
        // campos (ventas_ayer / pedidos_ayer / ticket_promedio_ayer /
        // pedidos_activos_ayer). renderComparativa() oculta el badge si el
        // dato no viene — no se calcula ni se muestra ningún número inventado.
        renderComparativa("compare-ventas-hoy", data.ventas_hoy, data.ventas_ayer);
        renderComparativa("compare-pedidos-hoy", data.pedidos_hoy, data.pedidos_ayer);
        renderComparativa("compare-ticket", data.ticket_promedio, data.ticket_promedio_ayer);
        renderComparativa("compare-activos", totalActivos, data.pedidos_activos_ayer);

        document.getElementById("metric-top").textContent = data.producto_top?.nombre || "-";
        document.getElementById("metric-top-help").textContent =
          data.producto_top?.cantidad ? `${data.producto_top.cantidad} vendidos hoy` : "Sin ventas hoy";
        const mesaNum = data.mesa_top?.numero;
        document.getElementById("metric-mesa-top").textContent =
          mesaNum != null ? `Mesa ${mesaNum}` : "-";
        document.getElementById("metric-mesa-top-help").textContent =
          mesaNum != null ? formatPrecio(data.mesa_top.total) : "Sin ventas hoy";

        document.getElementById("metric-categoria-top").textContent = data.categoria_top?.nombre || "-";
        document.getElementById("metric-categoria-top-help").textContent = data.categoria_top
          ? `${data.categoria_top.porcentaje}% de lo vendido hoy`
          : "Sin ventas hoy";

        // Requiere las columnas de trazabilidad de la migración 004. Si el
        // backend no las tiene (o todavía no hay pedidos listos hoy), el
        // dato viene null y la tarjeta se oculta en vez de mostrar un "—".
        const tiempoPrepCard = document.getElementById("card-tiempo-prep");
        if (data.tiempo_prep_promedio_min != null) {
          document.getElementById("metric-tiempo-prep").textContent =
            `${Math.round(data.tiempo_prep_promedio_min)} min`;
          tiempoPrepCard.style.display = "";
        } else {
          tiempoPrepCard.style.display = "none";
        }

        renderDonutCobros(data.cobros_hoy);
        renderDonutEstados(data.estado_pedidos_hoy);
        actualizarMetaVentasDiaria(data.ventas_hoy);
      } catch (error) {
        mostrarToast("No se pudieron cargar las métricas: " + error.message, "error");
      }
    }

    function conectarNotificacionesAdmin() {
      if (!window.COCINA_DEVICE_TOKEN) return;

      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      const socket = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?device_token=${encodeURIComponent(window.COCINA_DEVICE_TOKEN)}`);

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
            cargarAlertaStock();
            if (!data.estado || ["confirmado", "en_preparacion", "listo", "entregado"].includes(data.estado)) {
              cargarGraficoVentas();
              cargarVentasSemana();
            }
          }
        } catch {
          cargarDashboard();
          cargarAlertaStock();
          cargarGraficoVentas();
          cargarVentasSemana();
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

    function formatFechaLocalISO(date) {
      const anio = date.getFullYear();
      const mes = String(date.getMonth() + 1).padStart(2, "0");
      const dia = String(date.getDate()).padStart(2, "0");
      return `${anio}-${mes}-${dia}`;
    }

    function sumarDiasISO(fechaIso, dias) {
      const date = parseFechaLocal(fechaIso);
      date.setDate(date.getDate() + dias);
      return formatFechaLocalISO(date);
    }

    function obtenerVentasPorFecha(fechaIso) {
      const item = ventasSemanaData.find(dia => dia.fecha === fechaIso);
      return Number(item?.ventas) || 0;
    }

    function actualizarMetaVentasDiaria(ventasHoyFallback = 0) {
      const ventasHoyEl = document.getElementById("daily-sales-current");
      const deltaEl = document.getElementById("daily-sales-delta");
      const goalLabelEl = document.getElementById("daily-goal-label");
      const goalBarEl = document.getElementById("daily-goal-bar");
      const goalPercentEl = document.getElementById("daily-goal-percent");
      const goalRemainingEl = document.getElementById("daily-goal-remaining");
      if (!ventasHoyEl || !deltaEl || !goalLabelEl || !goalBarEl || !goalPercentEl || !goalRemainingEl) return;

      const hoyIso = formatFechaLocalISO(new Date());
      const ayerIso = sumarDiasISO(hoyIso, -1);
      const ventasHoySemana = obtenerVentasPorFecha(hoyIso);
      const ventasAyer = obtenerVentasPorFecha(ayerIso);
      const ventasHoy = ventasHoySemana || Number(ventasHoyFallback) || 0;
      const progreso = META_VENTAS_DIARIA > 0 ? Math.min((ventasHoy / META_VENTAS_DIARIA) * 100, 100) : 0;
      const restante = Math.max(META_VENTAS_DIARIA - ventasHoy, 0);

      ventasHoyEl.textContent = formatPrecio(ventasHoy);
      goalLabelEl.textContent = formatPrecio(META_VENTAS_DIARIA);
      goalBarEl.style.width = `${progreso.toFixed(0)}%`;
      goalPercentEl.textContent = `${progreso.toFixed(0)}% alcanzado`;
      goalRemainingEl.textContent = restante > 0 ? `${formatPrecio(restante)} restante` : "Meta alcanzada";

      deltaEl.classList.remove("is-up", "is-down", "is-neutral");
      if (ventasAyer > 0) {
        const variacion = ((ventasHoy - ventasAyer) / ventasAyer) * 100;
        const signo = variacion >= 0 ? "+" : "";
        deltaEl.textContent = `${signo}${variacion.toFixed(0)}% vs ayer`;
        deltaEl.classList.add(variacion >= 0 ? "is-up" : "is-down");
        renderComparativa("compare-ventas-hoy", ventasHoy, ventasAyer);
        return;
      }

      deltaEl.textContent = ventasHoy > 0 ? "Sin ventas ayer" : "Sin ventas registradas";
      deltaEl.classList.add("is-neutral");
      const compareVentas = document.getElementById("compare-ventas-hoy");
      if (compareVentas) {
        compareVentas.style.display = "none";
        compareVentas.textContent = "";
      }
    }

    async function cargarAlertaStock() {
      const alerta = document.getElementById("stock-alert-dashboard");
      if (!alerta) return;

      try {
        const inventario = await fetchAPI("/inventario/", "GET");
        const productos = Array.isArray(inventario) ? inventario : [];
        const criticos = productos
          .map(producto => ({ ...producto, estadoStock: normalizarEstadoStock(producto) }))
          .filter(producto => producto.estadoStock !== "OK");

        if (!criticos.length) {
          alerta.hidden = true;
          return;
        }

        const agotados = criticos.filter(producto => producto.estadoStock === "AGOTADO");
        const bajoMinimo = criticos.filter(producto => producto.estadoStock === "BAJO");
        const total = criticos.length;
        const title = document.getElementById("stock-alert-title");
        const metrics = document.getElementById("stock-alert-metrics");

        if (title) {
          title.textContent = "Revisión de stock requerida";
        }

        if (metrics) {
          metrics.innerHTML = `
            <div class="stock-alert-metric is-danger">
              <strong>${agotados.length}</strong>
              <span>Agotados</span>
            </div>
            <div class="stock-alert-metric">
              <strong>${bajoMinimo.length}</strong>
              <span>Bajo mínimo</span>
            </div>
          `;
        }

        alerta.hidden = false;
        if (window.lucide) lucide.createIcons();
      } catch (error) {
        alerta.hidden = true;
      }
    }

    function normalizarEstadoStock(producto) {
      const actual = Number(producto.stock_actual) || 0;
      const minimo = Number(producto.stock_minimo) || 0;
      if (actual <= 0) return "AGOTADO";
      if (minimo > 0 && actual < minimo) return "BAJO";
      return "OK";
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    // Muestra "+X% vs ayer" solo si el backend envió el valor de ayer.
    // Sin ese dato, el badge queda oculto (nunca se inventa un porcentaje).
    function renderComparativa(elId, hoy, ayer) {
      const el = document.getElementById(elId);
      if (!el) return;

      const ayerNum = Number(ayer);
      if (ayer == null || !isFinite(ayerNum) || ayerNum === 0 || hoy == null) {
        el.style.display = "none";
        el.textContent = "";
        return;
      }

      const variacion = ((Number(hoy) - ayerNum) / ayerNum) * 100;
      const signo = variacion >= 0 ? "+" : "";
      el.textContent = `${signo}${variacion.toFixed(0)}% vs ayer`;
      el.classList.toggle("stat-card-compare-up", variacion >= 0);
      el.classList.toggle("stat-card-compare-down", variacion < 0);
      el.style.display = "inline-flex";
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

    let ventasChart = null;

    // Devuelve solo el tramo de horas con ventas (más 1h de margen a cada
    // lado, dentro de 0-23). Si no hay ninguna venta, devuelve todo el rango
    // sin cambios (el estado vacío ya se maneja aparte con .chart-empty).
    function recortarRangoActivo(data) {
      let inicio = -1;
      let fin = -1;
      data.forEach((item, i) => {
        if ((Number(item.ventas) || 0) > 0) {
          if (inicio === -1) inicio = i;
          fin = i;
        }
      });
      if (inicio === -1) return data;

      const margen = 1;
      const desde = Math.max(0, inicio - margen);
      const hasta = Math.min(data.length - 1, fin + margen);
      return data.slice(desde, hasta + 1);
    }

    function renderGraficoVentas() {
      const canvas = document.getElementById("ventas-chart");
      const empty = document.getElementById("chart-empty");
      if (!canvas) return;

      const dataCompleta = ventasChartData.length ? ventasChartData : [];
      const maxVenta = Math.max(...dataCompleta.map(item => Number(item.ventas) || 0), 0);
      empty.style.display = maxVenta > 0 ? "none" : "grid";

      // Si las ventas están concentradas en pocas horas, recortamos el eje X
      // a ese rango (con 1h de margen a cada lado) para que el gráfico no
      // se vea vacío con dos barras perdidas en 24 columnas.
      const data = recortarRangoActivo(dataCompleta);

      const labels = data.map(item => item.label.replace(":00", "h"));
      const valores = data.map(item => Number(item.ventas) || 0);

      if (ventasChart) {
        ventasChart.data.labels = labels;
        ventasChart.data.datasets[0].data = valores;
        ventasChart.update();
        return;
      }

      ventasChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [{
            data: valores,
            backgroundColor: "#166273",
            borderRadius: 4,
            maxBarThickness: 26,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              displayColors: false,
              callbacks: {
                label: (ctx) => formatPrecio(ctx.parsed.y),
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: "#64748B",
                font: { family: "Inter", size: 11 },
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 12,
              },
            },
            y: {
              beginAtZero: true,
              grid: { color: "#E2E8F0" },
              ticks: {
                color: "#64748B",
                font: { family: "Inter", size: 11 },
                callback: (value) => formatNumeroCompacto(value),
              },
            },
          },
        },
      });
    }

    function formatNumeroCompacto(valor) {
      const numero = Number(valor) || 0;
      if (numero >= 1000000) return `$${(numero / 1000000).toFixed(1)}M`;
      if (numero >= 1000) return `$${Math.round(numero / 1000)}k`;
      return `$${Math.round(numero)}`;
    }

    // ── COBROS POR MÉTODO DE PAGO (dona) ────────────────────────
    let cobrosChart = null;
    const COLORES_METODOS = ["#166273", "#4A9CAD", "#B45309", "#94A3B8", "#15803D"];

    function capitalizar(texto) {
      const s = String(texto || "");
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function renderDonutCobros(cobrosHoy) {
      const canvas = document.getElementById("cobros-chart");
      const emptyEl = document.getElementById("donut-empty");
      const legendEl = document.getElementById("donut-legend");
      if (!canvas) return;

      const metodos = (cobrosHoy && cobrosHoy.metodos) || {};
      const entradas = Object.entries(metodos);
      const labels = entradas.map(([metodo]) => capitalizar(metodo));
      const valores = entradas.map(([, info]) => Number(info.total) || 0);
      const total = valores.reduce((acc, v) => acc + v, 0);

      if (emptyEl) emptyEl.style.display = total > 0 ? "none" : "flex";

      if (cobrosChart) {
        cobrosChart.data.labels = labels;
        cobrosChart.data.datasets[0].data = valores;
        cobrosChart.update();
      } else {
        cobrosChart = new Chart(canvas.getContext("2d"), {
          type: "doughnut",
          data: {
            labels,
            datasets: [{
              data: valores,
              backgroundColor: COLORES_METODOS,
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "68%",
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.label}: ${formatPrecio(ctx.parsed)}`,
                },
              },
            },
          },
        });
      }

      if (legendEl) {
        legendEl.innerHTML = entradas.length
          ? entradas.map(([metodo, info], i) => `
              <div class="donut-legend-item">
                <span class="donut-legend-dot" style="background:${COLORES_METODOS[i % COLORES_METODOS.length]}"></span>
                <span class="donut-legend-label">${capitalizar(metodo)}</span>
                <span class="donut-legend-value">${formatPrecio(info.total)}</span>
              </div>
            `).join("")
          : "";
      }
    }

    // ── ESTADO DE PEDIDOS DE HOY (dona) ─────────────────────────
    let estadosChart = null;
    const ESTADO_PEDIDOS_INFO = {
      pendiente:      { label: "Pendiente",      color: "#E8A317" },
      confirmado:     { label: "Confirmado",     color: "#4A9CAD" },
      en_preparacion: { label: "En preparación", color: "#166273" },
      listo:          { label: "Listo",          color: "#22C55E" },
      entregado:      { label: "Entregado",      color: "#94A3B8" },
      cancelado:      { label: "Cancelado",      color: "#E23B3B" },
    };

    function renderDonutEstados(estadoPedidosHoy) {
      const canvas = document.getElementById("estados-chart");
      const emptyEl = document.getElementById("estados-empty");
      const legendEl = document.getElementById("estados-legend");
      if (!canvas) return;

      const estados = estadoPedidosHoy || {};
      const entradas = Object.entries(ESTADO_PEDIDOS_INFO)
        .map(([clave, info]) => [clave, info, Number(estados[clave]) || 0])
        .filter(([, , cantidad]) => cantidad > 0);

      const total = entradas.reduce((acc, [, , cantidad]) => acc + cantidad, 0);
      if (emptyEl) emptyEl.style.display = total > 0 ? "none" : "flex";

      const labels = entradas.map(([, info]) => info.label);
      const valores = entradas.map(([, , cantidad]) => cantidad);
      const colores = entradas.map(([, info]) => info.color);

      if (estadosChart) {
        estadosChart.data.labels = labels;
        estadosChart.data.datasets[0].data = valores;
        estadosChart.data.datasets[0].backgroundColor = colores;
        estadosChart.update();
      } else {
        estadosChart = new Chart(canvas.getContext("2d"), {
          type: "doughnut",
          data: {
            labels,
            datasets: [{
              data: valores,
              backgroundColor: colores,
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "68%",
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.label}: ${ctx.parsed} pedido${ctx.parsed === 1 ? "" : "s"}`,
                },
              },
            },
          },
        });
      }

      if (legendEl) {
        legendEl.innerHTML = entradas.length
          ? entradas.map(([, info, cantidad], i) => `
              <div class="donut-legend-item">
                <span class="donut-legend-dot" style="background:${colores[i]}"></span>
                <span class="donut-legend-label">${info.label}</span>
                <span class="donut-legend-value">${cantidad}</span>
              </div>
            `).join("")
          : "";
      }
    }

    // ── TENDENCIA SEMANAL ────────────────────────────────────────
    function parseFechaLocal(iso) {
      const [anio, mes, dia] = iso.split("-").map(Number);
      return new Date(anio, mes - 1, dia);
    }

    function formatDiaSemana(iso) {
      const texto = parseFechaLocal(iso).toLocaleDateString("es-AR", { weekday: "short" });
      return texto.charAt(0).toUpperCase() + texto.slice(1).replace(".", "");
    }

    let ventasSemanaData = [];

    async function cargarVentasSemana() {
      try {
        const data = await fetchAPI("/reportes/ventas-semana");
        ventasSemanaData = data.serie || [];
        document.getElementById("semana-total").textContent = formatPrecio(data.total_ventas || 0);
        document.getElementById("semana-orders").textContent =
          `${Number(data.total_pedidos || 0)} pedidos confirmados`;
        actualizarMetaVentasDiaria();
        renderGraficoSemana();
      } catch (error) {
        document.getElementById("semana-empty").textContent = "No se pudo cargar la tendencia semanal.";
        document.getElementById("semana-empty").style.display = "grid";
      }
    }

    let semanaChart = null;

    function renderGraficoSemana() {
      const canvas = document.getElementById("semana-chart");
      const empty = document.getElementById("semana-empty");
      if (!canvas) return;

      const data = ventasSemanaData;
      const maxVenta = Math.max(...data.map(item => Number(item.ventas) || 0), 0);
      empty.style.display = maxVenta > 0 ? "none" : "grid";

      const labels = data.map(item => formatDiaSemana(item.fecha));
      const valores = data.map(item => Number(item.ventas) || 0);

      if (semanaChart) {
        semanaChart.data.labels = labels;
        semanaChart.data.datasets[0].data = valores;
        semanaChart.update();
        return;
      }

      semanaChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            data: valores,
            borderColor: "#166273",
            backgroundColor: "rgba(22, 98, 115, 0.08)",
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointBackgroundColor: "#166273",
            pointBorderColor: "#166273",
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              displayColors: false,
              callbacks: {
                label: (ctx) => formatPrecio(ctx.parsed.y),
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: "#64748B", font: { family: "Inter", size: 11 } },
            },
            y: {
              beginAtZero: true,
              grid: { color: "#E2E8F0" },
              ticks: {
                color: "#64748B",
                font: { family: "Inter", size: 11 },
                callback: (value) => formatNumeroCompacto(value),
              },
            },
          },
        },
      });
    }

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

    // ── CALENDARIO (Reportes) ──────────────────────────────────────
    // Puramente de UI + atajo de carga: elegir un día completa los
    // campos de fecha de las tarjetas de reportes de abajo. No consulta
    // la API ni guarda nada — es un selector visual, no un feature nuevo.
    let calFecha = new Date();
    calFecha.setDate(1);
    let calSeleccionado = null;

    const MESES_CAL = [
      "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
      "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
    ];

    function renderCalendario() {
      const label = document.getElementById("cal-month-label");
      const grid = document.getElementById("cal-grid");
      if (!label || !grid) return;

      label.textContent = `${MESES_CAL[calFecha.getMonth()]} ${calFecha.getFullYear()}`;

      const hoy = new Date();
      const primerDia = new Date(calFecha.getFullYear(), calFecha.getMonth(), 1);
      const ultimoDia = new Date(calFecha.getFullYear(), calFecha.getMonth() + 1, 0);
      const offset = (primerDia.getDay() + 6) % 7; // semana arranca en lunes

      let celdas = "";
      for (let i = 0; i < offset; i++) {
        celdas += `<span class="cal-day cal-day-empty"></span>`;
      }
      for (let dia = 1; dia <= ultimoDia.getDate(); dia++) {
        const esHoy = hoy.getFullYear() === calFecha.getFullYear()
          && hoy.getMonth() === calFecha.getMonth()
          && hoy.getDate() === dia;
        const esSeleccionado = calSeleccionado
          && calSeleccionado.getFullYear() === calFecha.getFullYear()
          && calSeleccionado.getMonth() === calFecha.getMonth()
          && calSeleccionado.getDate() === dia;
        const clases = ["cal-day"];
        if (esHoy) clases.push("cal-day-today");
        if (esSeleccionado) clases.push("cal-day-selected");
        celdas += `<button type="button" class="${clases.join(" ")}" onclick="calendarSeleccionarDia(${dia})">${dia}</button>`;
      }
      grid.innerHTML = celdas;
    }

    function calendarPrevMonth() {
      calFecha.setMonth(calFecha.getMonth() - 1);
      renderCalendario();
    }

    function calendarNextMonth() {
      calFecha.setMonth(calFecha.getMonth() + 1);
      renderCalendario();
    }

    function calendarIrHoy() {
      calFecha = new Date();
      calFecha.setDate(1);
      renderCalendario();
    }

    function calendarSeleccionarDia(dia) {
      calSeleccionado = new Date(calFecha.getFullYear(), calFecha.getMonth(), dia);
      const iso = formatFecha(calSeleccionado);

      document.getElementById("fecha-inicio").value = iso;
      document.getElementById("fecha-fin").value = iso;
      const fechaResumen = document.getElementById("fecha-resumen");
      if (fechaResumen) fechaResumen.value = iso;

      const label = document.getElementById("cal-selected-label");
      if (label) {
        label.textContent = calSeleccionado.toLocaleDateString("es-AR", {
          day: "numeric", month: "long", year: "numeric",
        });
      }

      renderCalendario();
    }

    if (tieneReportes) renderCalendario();

    // ── GENERAR REPORTE DE VENTAS ────────────────────────────────
    async function generarReporteVentas(formato = "excel") {
      const fechaInicio = document.getElementById("fecha-inicio").value;
      const fechaFin    = document.getElementById("fecha-fin").value;
      const extension = formato === "pdf" ? "pdf" : "xlsx";
      const formatoLabel = formato === "pdf" ? "PDF" : "Excel";

      // Validaciones
      if (!fechaInicio || !fechaFin) {
        mostrarToast("Seleccioná ambas fechas para generar el reporte.", "error");
        return;
      }
      if (fechaInicio > fechaFin) {
        mostrarToast("La fecha de inicio no puede ser mayor a la fecha fin.", "error");
        return;
      }

      const btn = document.getElementById(`btn-ventas-${formato}`);
      const botones = document.querySelectorAll("[id^='btn-ventas-']");
      botones.forEach(boton => boton.disabled = true);
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> Generando ${formatoLabel}...`;

      try {
        // GET /reportes/ventas?fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
        // Devuelve un archivo Excel o PDF — usamos downloadFile() de api.js
        const endpoint  = `/reportes/ventas?fecha_inicio=${fechaInicio}&fecha_fin=${fechaFin}&formato=${formato}`;
        const filename  = `reporte_ventas_${fechaInicio}_${fechaFin}.${extension}`;

        await downloadFile(endpoint, filename);

        mostrarToast(`Reporte ${formatoLabel} descargado correctamente.`, "success");
        agregarHistorial(filename, fechaInicio, fechaFin);

      } catch (error) {
        mostrarToast("Error al generar el reporte: " + error.message, "error");
      } finally {
        botones.forEach(boton => boton.disabled = false);
        document.getElementById("btn-ventas-excel").innerHTML = '<i data-lucide="file-spreadsheet"></i> Excel';
        document.getElementById("btn-ventas-pdf").innerHTML = '<i data-lucide="file-text"></i> PDF';
        if (window.lucide) lucide.createIcons();
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

    // ── RESUMEN DEL DÍA ─────────────────────────────────────────
    async function descargarResumenHoy(formato = "excel") {
      const fecha = document.getElementById("fecha-resumen")?.value;
      const params = fecha ? `?fecha=${fecha}` : "";
      const fechaLabel = fecha || new Date().toISOString().split("T")[0];
      const extension = formato === "pdf" ? "pdf" : "xlsx";
      const formatoLabel = formato === "pdf" ? "PDF" : "Excel";
      const separator = params ? "&" : "?";
      const btn = document.getElementById(`btn-resumen-${formato}`);
      const botones = document.querySelectorAll("[id^='btn-resumen-']");
      botones.forEach(boton => boton.disabled = true);
      btn.innerHTML = `<span class="spinner"></span> Generando ${formatoLabel}...`;
      try {
        await downloadFile(`/reportes/resumen-hoy${params}${separator}formato=${formato}`, `resumen_${fechaLabel}.${extension}`);
        mostrarToast(`Resumen ${formatoLabel} descargado correctamente.`, "success");
      } catch (error) {
        mostrarToast("Error al generar el resumen: " + error.message, "error");
      } finally {
        botones.forEach(boton => boton.disabled = false);
        document.getElementById("btn-resumen-excel").innerHTML = '<i data-lucide="file-spreadsheet"></i> Excel';
        document.getElementById("btn-resumen-pdf").innerHTML = '<i data-lucide="file-text"></i> PDF';
        if (window.lucide) lucide.createIcons();
      }
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
  
