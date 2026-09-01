
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
    const tieneControlMozos = Boolean(document.getElementById("mozo-fecha-inicio"));

    // ── FECHAS POR DEFECTO (hoy) ─────────────────────────────────
    const hoy = new Date().toISOString().split("T")[0];
    if (tieneReportes) {
      document.getElementById("fecha-inicio").value = hoy;
      document.getElementById("fecha-fin").value = hoy;
      const fechaResumen = document.getElementById("fecha-resumen");
      if (fechaResumen) fechaResumen.value = hoy;
    }

    if (tieneControlMozos) {
      const d = new Date();
      document.getElementById("mozo-fecha-inicio").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      document.getElementById("mozo-fecha-fin").value = hoy;
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
        const inventario = await fetchAPI("/inventario/?page=1&limit=1", "GET");
        const resumen = inventario?.resumen || null;
        const productos = Array.isArray(inventario)
          ? inventario
          : Array.isArray(inventario?.items)
            ? inventario.items
            : [];
        const criticos = productos
          .map(producto => ({ ...producto, estadoStock: normalizarEstadoStock(producto) }))
          .filter(producto => producto.estadoStock !== "OK");
        const agotadosCount = resumen
          ? Number(resumen.agotado) || 0
          : criticos.filter(producto => producto.estadoStock === "AGOTADO").length;
        const bajoMinimoCount = resumen
          ? Number(resumen.bajo) || 0
          : criticos.filter(producto => producto.estadoStock === "BAJO").length;
        const total = resumen
          ? Number(resumen.criticos) || (agotadosCount + bajoMinimoCount)
          : criticos.length;

        if (!total) {
          alerta.hidden = true;
          return;
        }

        const title = document.getElementById("stock-alert-title");
        const metrics = document.getElementById("stock-alert-metrics");

        if (title) {
          title.textContent = "Revisión de stock requerida";
        }

        if (metrics) {
          metrics.innerHTML = `
            <div class="stock-alert-metric is-danger">
              <strong>${agotadosCount}</strong>
              <span>Agotados</span>
            </div>
            <div class="stock-alert-metric">
              <strong>${bajoMinimoCount}</strong>
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
    if (tieneControlMozos && !tieneReportes) verReporteMozos();

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

    // ── REPORTE POR MOZO ───────────────────────────────────────
    function _rangoMozos() {
      const inicio = document.getElementById("mozo-fecha-inicio")?.value;
      const fin    = document.getElementById("mozo-fecha-fin")?.value;
      if (!inicio || !fin) {
        mostrarToast("Elegí ambas fechas.", "error");
        return null;
      }
      if (inicio > fin) {
        mostrarToast("La fecha 'Desde' no puede ser mayor a 'Hasta'.", "error");
        return null;
      }
      return { inicio, fin };
    }

    async function verReporteMozos() {
      const r = _rangoMozos();
      if (!r) return;
      const btn = document.getElementById("btn-mozos-ver");
      const wrap = document.getElementById("mozos-tabla-wrap");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Cargando...';
      try {
        const data = await fetchAPI(`/reportes/mozos?fecha_inicio=${r.inicio}&fecha_fin=${r.fin}`);
        renderTablaMozos(data);
        wrap.hidden = false;
      } catch (error) {
        mostrarToast("No se pudo cargar el reporte: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="eye"></i> Ver';
        if (window.lucide) lucide.createIcons();
      }
    }

    let ultimoReporteMozos = null;
    let ultimoRegistroCobrosMozos = [];
    let ultimoIdsVisiblesMozos = new Set();
    let ultimoCierreSeleccionadoMozos = null;
    let filtroMozoBusqueda = "";
    let filtroMozoActividad = "todos";

    function fechaLocalKey(valor) {
      const fecha = new Date(valor);
      if (Number.isNaN(fecha.getTime())) return "";
      return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;
    }

    function formatearFechaHoraCorta(valor) {
      if (!valor) return "—";
      const fecha = new Date(valor);
      if (Number.isNaN(fecha.getTime())) return String(valor);
      return fecha.toLocaleString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function formatearMetodoPago(metodo) {
      return capitalizar(String(metodo || "otro").replaceAll("_", " "));
    }

    function obtenerCobrosFiltradosMozos(filtro = "recientes") {
      let ordenados = [...ultimoRegistroCobrosMozos].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
      );
      if (ultimoIdsVisiblesMozos.size) {
        ordenados = ordenados.filter(cobro => ultimoIdsVisiblesMozos.has(String(cobro.id_usuario)));
      } else {
        ordenados = [];
      }
      const ahora = new Date();
      const hoyKey = fechaLocalKey(ahora);
      const ayer = new Date(ahora);
      ayer.setDate(ayer.getDate() - 1);
      const ayerKey = fechaLocalKey(ayer);
      const haceSemana = new Date(ahora);
      haceSemana.setDate(haceSemana.getDate() - 7);

      if (filtro === "hoy") {
        return ordenados.filter(cobro => fechaLocalKey(cobro.created_at) === hoyKey);
      }
      if (filtro === "ayer") {
        return ordenados.filter(cobro => fechaLocalKey(cobro.created_at) === ayerKey);
      }
      if (filtro === "semana") {
        return ordenados.filter(cobro => new Date(cobro.created_at || 0) >= haceSemana);
      }
      if (filtro === "todos") {
        return ordenados;
      }
      return ordenados.slice(0, 8);
    }

    function renderRegistroCobrosMozos(filtro = "recientes") {
      const contenedor = document.getElementById("mozos-registro-list");
      const contador = document.getElementById("mozos-registro-contador");
      if (!contenedor) return;
      const cobros = obtenerCobrosFiltradosMozos(filtro);
      if (contador) contador.textContent = `${cobros.length} movimiento${cobros.length === 1 ? "" : "s"}`;
      if (!cobros.some(cobro => String(cobro.id_cierre) === String(ultimoCierreSeleccionadoMozos))) {
        ultimoCierreSeleccionadoMozos = null;
      }
      const cobroSeleccionado = cobros.find(cobro => String(cobro.id_cierre) === String(ultimoCierreSeleccionadoMozos));

      contenedor.innerHTML = cobros.length ? `
        <div class="mozos-registro-split ${cobroSeleccionado ? "has-ticket" : ""}">
          <div class="mozos-registro-movimientos">
            ${cobros.map(cobro => `
              <button type="button" class="mozo-cobro-item ${String(cobro.id_cierre) === String(cobroSeleccionado?.id_cierre) ? "is-active" : ""}" data-cierre-id="${String(cobro.id_cierre)}" onclick="seleccionarCierreMozo('${String(cobro.id_cierre)}')">
                <span class="mozo-cobro-id">
                  <i data-lucide="receipt-text"></i>
                </span>
                <span class="mozo-cobro-info">
                  <strong>Cierre #${cobro.id_cierre}</strong>
                  <span>${escapeHtml(cobro.mozo || "Mozo")} - ${cobro.numero_mesa ? `Mesa ${cobro.numero_mesa}` : "Mesa sin numero"}</span>
                  <small>${formatearFechaHoraCorta(cobro.created_at)}</small>
                </span>
                <span class="mozo-cobro-side">
                  <span class="mozo-metodo-badge">${escapeHtml(formatearMetodoPago(cobro.metodo_pago))}</span>
                  <b>${formatPrecio(cobro.total_consumido)}</b>
                </span>
              </button>`).join("")}
          </div>
          <aside class="mozos-registro-detalle" id="mozos-registro-detalle" ${cobroSeleccionado ? "" : "hidden"}>
            ${renderTicketCierreMozo(cobroSeleccionado)}
          </aside>
        </div>` : `
        <div class="mozos-mini-empty">Sin cobros para este filtro.</div>`;
      if (window.lucide) lucide.createIcons();
    }

    window.filtrarRegistroMozos = renderRegistroCobrosMozos;

    function renderTicketCierreMozo(cobro) {
      if (!cobro) {
        return `<div class="mozo-ticket-empty">Selecciona un cierre para ver el detalle.</div>`;
      }
      return `
        <div class="mozo-ticket-body">
          <div class="mozo-ticket-title">
            <div>
              <span>Ticket de cierre</span>
              <strong>${cobro.numero_mesa ? `Mesa ${cobro.numero_mesa}` : "Mesa sin numero"}</strong>
            </div>
            <b>#${cobro.id_cierre}</b>
          </div>
          <div class="mozo-ticket-lines">
            <div><span>Mesa cobrada</span><strong>${cobro.numero_mesa ? `Mesa ${cobro.numero_mesa}` : "Mesa sin numero"}</strong></div>
            <div><span>Numero de pedido o cierre</span><strong>Cierre #${cobro.id_cierre}</strong></div>
            <div><span>Metodo de pago</span><strong>${escapeHtml(formatearMetodoPago(cobro.metodo_pago))}</strong></div>
            <div><span>Total consumido</span><strong>${formatPrecio(cobro.total_consumido)}</strong></div>
            <div><span>Monto cobrado</span><strong>${formatPrecio(cobro.monto_cobrado)}</strong></div>
            <div><span>Vuelto</span><strong>${formatPrecio(cobro.vuelto)}</strong></div>
            <div><span>Fecha y hora</span><strong>${formatearFechaHoraCorta(cobro.created_at)}</strong></div>
            <div><span>Mozo responsable</span><strong>${escapeHtml(cobro.mozo || "Mozo")}</strong></div>
          </div>
          ${cobro.observaciones ? `
            <div class="mozo-ticket-observacion">
              <span>Observacion</span>
              <p>${escapeHtml(cobro.observaciones)}</p>
            </div>` : ""}
        </div>`;
    }

    window.seleccionarCierreMozo = function seleccionarCierreMozo(idCierre) {
      ultimoCierreSeleccionadoMozos = idCierre;
      const cobro = ultimoRegistroCobrosMozos.find(item => String(item.id_cierre) === String(idCierre));
      document.querySelectorAll(".mozo-cobro-item").forEach(item => {
        item.classList.toggle("is-active", item.dataset.cierreId === String(idCierre));
      });
      const detalle = document.getElementById("mozos-registro-detalle");
      if (detalle) {
        detalle.hidden = false;
        detalle.innerHTML = renderTicketCierreMozo(cobro);
      }
      const split = document.querySelector(".mozos-registro-split");
      if (split) split.classList.add("has-ticket");
      if (window.lucide) lucide.createIcons();
    };

    function mozoControlKey(mozo) {
      return String(mozo.id_usuario ?? mozo.nombre ?? "");
    }

    function textoBusquedaMozo(mozo) {
      return [
        mozo.id_usuario,
        mozo.nombre,
        mozo.rol,
        mozo.activo ? "activo" : "inactivo",
      ].join(" ").toLowerCase();
    }

    function filtrarMozosControl(filas) {
      const texto = filtroMozoBusqueda.trim().toLowerCase();
      let visibles = texto
        ? filas.filter(mozo => textoBusquedaMozo(mozo).includes(texto))
        : [...filas];

      if (filtroMozoActividad === "con-cobros") {
        visibles = visibles.filter(mozo => Number(mozo.mesas_cerradas) > 0);
      } else if (filtroMozoActividad === "sin-actividad") {
        visibles = visibles.filter(mozo =>
          Number(mozo.mesas_cerradas) === 0 &&
          Number(mozo.ventas_cobradas) === 0 &&
          Number(mozo.pedidos_entregados) === 0 &&
          Number(mozo.llamados_atendidos) === 0
        );
      } else if (filtroMozoActividad === "mayor-recaudacion") {
        visibles.sort((a, b) => (Number(b.ventas_cobradas) || 0) - (Number(a.ventas_cobradas) || 0));
      } else if (filtroMozoActividad === "mayor-mesas") {
        visibles.sort((a, b) => (Number(b.mesas_cerradas) || 0) - (Number(a.mesas_cerradas) || 0));
      } else if (filtroMozoActividad === "respuesta-alta") {
        visibles = visibles
          .filter(mozo => mozo.respuesta_promedio_min != null)
          .sort((a, b) => (Number(b.respuesta_promedio_min) || 0) - (Number(a.respuesta_promedio_min) || 0));
      }

      return visibles;
    }

    window.actualizarBusquedaMozos = function actualizarBusquedaMozos(valor) {
      filtroMozoBusqueda = valor || "";
      if (ultimoReporteMozos) {
        renderTablaMozos(ultimoReporteMozos);
        setTimeout(() => {
          const input = document.getElementById("mozos-busqueda-control");
          if (!input) return;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }, 0);
      }
    };

    window.actualizarActividadMozos = function actualizarActividadMozos(valor) {
      filtroMozoActividad = valor || "todos";
      if (ultimoReporteMozos) renderTablaMozos(ultimoReporteMozos);
    };

    function renderTablaMozos(data) {
      ultimoReporteMozos = data;
      const wrap = document.getElementById("mozos-tabla-wrap");
      const filas = (Array.isArray(data.mozos) ? data.mozos : [])
        .filter(m => String(m.rol || "").toLowerCase() === "mozo");
      const registroCobros = Array.isArray(data.registro_cobros) ? data.registro_cobros : [];
      ultimoRegistroCobrosMozos = registroCobros;
      const arqueo = Array.isArray(data.arqueo) ? data.arqueo : [];
      const filasVisibles = filtrarMozosControl(filas);
      ultimoIdsVisiblesMozos = new Set(filasVisibles.map(mozo => mozoControlKey(mozo)));
      const idsVisibles = new Set(filasVisibles.map(mozo => String(mozo.id_usuario)));
      const arqueoVisible = arqueo.filter(item => idsVisibles.has(String(item.id_usuario)));
      const t = filasVisibles.reduce((acc, m) => {
        acc.mesas_cerradas += Number(m.mesas_cerradas) || 0;
        acc.ventas_cobradas += Number(m.ventas_cobradas) || 0;
        acc.pedidos_entregados += Number(m.pedidos_entregados) || 0;
        acc.llamados_atendidos += Number(m.llamados_atendidos) || 0;
        return acc;
      }, { mesas_cerradas: 0, ventas_cobradas: 0, pedidos_entregados: 0, llamados_atendidos: 0 });
      const ticketPromedioGeneral = t.mesas_cerradas ? t.ventas_cobradas / t.mesas_cerradas : 0;

      if (!filas.length) {
        wrap.innerHTML = `
          <section class="mozos-filter-panel">
            <div class="mozos-search-control">
              <i data-lucide="search"></i>
              <input id="mozos-busqueda-control" type="search" placeholder="Buscar mozo por nombre, rol o ID..." value="${escapeHtml(filtroMozoBusqueda)}" oninput="actualizarBusquedaMozos(this.value)" />
            </div>
            <select class="mozos-activity-filter" onchange="actualizarActividadMozos(this.value)">
              <option value="todos">Todos los mozos</option>
            </select>
          </section>
          <div class="mozos-empty">
            <i data-lucide="user-check"></i>
            <div>
              <strong>Sin cobros de mozos en este periodo</strong>
              <span>Cuando un mozo cierre mesas, el registro va a aparecer aca.</span>
            </div>
          </div>`;
        if (window.lucide) lucide.createIcons();
        return;
      }

      if (!filasVisibles.length) {
        wrap.innerHTML = `
          <section class="mozos-filter-panel">
            <div class="mozos-search-control">
              <i data-lucide="search"></i>
              <input id="mozos-busqueda-control" type="search" placeholder="Buscar mozo por nombre, rol o ID..." value="${escapeHtml(filtroMozoBusqueda)}" oninput="actualizarBusquedaMozos(this.value)" />
            </div>
            <select class="mozos-activity-filter" onchange="actualizarActividadMozos(this.value)">
              <option value="todos"${filtroMozoActividad === "todos" ? " selected" : ""}>Todos los mozos</option>
              <option value="con-cobros"${filtroMozoActividad === "con-cobros" ? " selected" : ""}>Con cobros</option>
              <option value="sin-actividad"${filtroMozoActividad === "sin-actividad" ? " selected" : ""}>Sin actividad</option>
              <option value="mayor-recaudacion"${filtroMozoActividad === "mayor-recaudacion" ? " selected" : ""}>Mayor recaudacion</option>
              <option value="mayor-mesas"${filtroMozoActividad === "mayor-mesas" ? " selected" : ""}>Mayor cantidad de mesas</option>
              <option value="respuesta-alta"${filtroMozoActividad === "respuesta-alta" ? " selected" : ""}>Mayor tiempo de respuesta</option>
            </select>
          </section>
          <div class="mozos-empty">
            <i data-lucide="search-x"></i>
            <div>
              <strong>Sin coincidencias</strong>
              <span>No hay mozos para la busqueda o filtro seleccionado.</span>
            </div>
          </div>`;
        if (window.lucide) lucide.createIcons();
        return;
      }

      const resp = m => (m.respuesta_promedio_min != null ? `${m.respuesta_promedio_min}′` : "—");
      const registroVisibleCount = registroCobros.filter(cobro => idsVisibles.has(String(cobro.id_usuario))).length;
      const arqueoPorMozo = arqueoVisible.reduce((acc, item) => {
        const id = item.id_usuario || item.mozo || "sin-id";
        if (!acc.has(id)) {
          acc.set(id, {
            mozo: item.mozo || "Mozo sin nombre",
            total: 0,
            cobrado: 0,
            vuelto: 0,
            cantidad: 0,
            metodos: {
              efectivo: 0,
              tarjeta: 0,
              qr: 0,
              otro: 0,
            },
          });
        }
        const grupo = acc.get(id);
        const metodo = ["efectivo", "tarjeta", "qr"].includes(item.metodo_pago) ? item.metodo_pago : "otro";
        grupo.total += Number(item.total_consumido) || 0;
        grupo.cobrado += Number(item.monto_cobrado) || 0;
        grupo.vuelto += Number(item.vuelto) || 0;
        grupo.cantidad += Number(item.cantidad) || 0;
        grupo.metodos[metodo] += Number(item.total_consumido) || 0;
        return acc;
      }, new Map());
      const arqueos = Array.from(arqueoPorMozo.values())
        .sort((a, b) => b.total - a.total);
      const arqueoFinal = arqueos.reduce((acc, item) => {
        acc.efectivo += item.metodos.efectivo;
        acc.tarjeta += item.metodos.tarjeta;
        acc.qr += item.metodos.qr;
        acc.otros += item.metodos.otro;
        acc.cobrado += item.cobrado;
        acc.vuelto += item.vuelto;
        return acc;
      }, { efectivo: 0, tarjeta: 0, qr: 0, otros: 0, cobrado: 0, vuelto: 0 });
      arqueoFinal.total = arqueoFinal.efectivo + arqueoFinal.tarjeta + arqueoFinal.qr + arqueoFinal.otros;

      wrap.innerHTML = `
        <section class="mozos-filter-panel">
          <div class="mozos-search-control">
            <i data-lucide="search"></i>
            <input id="mozos-busqueda-control" type="search" placeholder="Buscar mozo por nombre, rol o ID..." value="${escapeHtml(filtroMozoBusqueda)}" oninput="actualizarBusquedaMozos(this.value)" />
          </div>
          <select class="mozos-activity-filter" onchange="actualizarActividadMozos(this.value)">
            <option value="todos"${filtroMozoActividad === "todos" ? " selected" : ""}>Todos los mozos</option>
            <option value="con-cobros"${filtroMozoActividad === "con-cobros" ? " selected" : ""}>Con cobros</option>
            <option value="sin-actividad"${filtroMozoActividad === "sin-actividad" ? " selected" : ""}>Sin actividad</option>
            <option value="mayor-recaudacion"${filtroMozoActividad === "mayor-recaudacion" ? " selected" : ""}>Mayor recaudacion</option>
            <option value="mayor-mesas"${filtroMozoActividad === "mayor-mesas" ? " selected" : ""}>Mayor cantidad de mesas</option>
            <option value="respuesta-alta"${filtroMozoActividad === "respuesta-alta" ? " selected" : ""}>Mayor tiempo de respuesta</option>
          </select>
        </section>
        <section class="mozos-panel mozos-resumen-card">
          <div class="mozos-panel-head">
            <div class="mozos-panel-titlebox">
              <span>Resumen del periodo</span>
              <small>${filasVisibles.length} mozo${filasVisibles.length === 1 ? "" : "s"}</small>
            </div>
          </div>
          <div class="mozos-resumen">
            <div class="mozo-kpi">
              <span>Ventas cobradas</span>
              <strong>${formatPrecio(t.ventas_cobradas)}</strong>
            </div>
            <div class="mozo-kpi">
              <span>Mesas cerradas</span>
              <strong>${t.mesas_cerradas}</strong>
            </div>
            <div class="mozo-kpi">
              <span>Cobros registrados</span>
              <strong>${registroVisibleCount}</strong>
            </div>
            <div class="mozo-kpi mozo-kpi-destacado">
              <span>Ticket promedio</span>
              <strong>${t.mesas_cerradas ? formatPrecio(ticketPromedioGeneral) : "—"}</strong>
            </div>
          </div>
        </section>
        <section class="mozos-panel mozos-caja-panel">
          <div class="mozos-panel-head">
            <div class="mozos-panel-titlebox">
              <span>Arqueo final del turno</span>
              <small>Cierre de caja</small>
            </div>
          </div>
          <div class="mozos-caja-grid">
            <div class="mozos-caja-total">
              <span>Total general</span>
              <strong>${formatPrecio(arqueoFinal.total)}</strong>
              <small>${t.mesas_cerradas} mesa${t.mesas_cerradas === 1 ? "" : "s"} cerrada${t.mesas_cerradas === 1 ? "" : "s"}</small>
            </div>
            <div class="mozos-caja-metodos">
              <div>
                <span>Efectivo esperado</span>
                <strong>${formatPrecio(arqueoFinal.efectivo)}</strong>
              </div>
              <div>
                <span>Tarjeta</span>
                <strong>${formatPrecio(arqueoFinal.tarjeta)}</strong>
              </div>
              <div>
                <span>QR</span>
                <strong>${formatPrecio(arqueoFinal.qr)}</strong>
              </div>
              <div>
                <span>Otros</span>
                <strong>${formatPrecio(arqueoFinal.otros)}</strong>
              </div>
            </div>
          </div>
        </section>
        <div class="mozos-cards-stack">
          <section class="mozos-panel mozos-arqueo-panel">
            <div class="mozos-panel-head">
              <div class="mozos-panel-titlebox">
                <span>Arqueo individual</span>
                <small>${t.mesas_cerradas ? formatPrecio(ticketPromedioGeneral) : "—"} ticket promedio</small>
              </div>
            </div>
            ${arqueos.length ? `
              <div class="mozos-tabla-scroll mozos-arqueo-scroll">
                <table class="mozos-tabla mozos-arqueo-tabla">
                  <thead>
                    <tr>
                      <th>Mozo</th>
                      <th class="num">Efectivo</th>
                      <th class="num">Tarjeta</th>
                      <th class="num">QR</th>
                      <th class="num">Otros</th>
                      <th class="num">Cierres</th>
                      <th class="num">Cobrado</th>
                      <th class="num">Vuelto</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${arqueos.map(item => `
                      <tr>
                        <td><strong>${escapeHtml(item.mozo)}</strong></td>
                        <td class="num">${formatPrecio(item.metodos.efectivo)}</td>
                        <td class="num">${formatPrecio(item.metodos.tarjeta)}</td>
                        <td class="num">${formatPrecio(item.metodos.qr)}</td>
                        <td class="num">${formatPrecio(item.metodos.otro)}</td>
                        <td class="num">${item.cantidad}</td>
                        <td class="num">${formatPrecio(item.cobrado)}</td>
                        <td class="num">${formatPrecio(item.vuelto)}</td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </div>` : `
              <div class="mozos-mini-empty">Sin arqueo para el rango seleccionado.</div>`}
          </section>

          <section class="mozos-panel mozos-registro-panel">
            <div class="mozos-panel-head">
              <div class="mozos-panel-titlebox">
                <span>Registro de cobros</span>
                <small id="mozos-registro-contador">0 movimientos</small>
              </div>
              <div class="mozos-registro-tools">
                <select class="mozos-registro-filter" onchange="filtrarRegistroMozos(this.value)">
                  <option value="recientes">Ultimos movimientos</option>
                  <option value="hoy">Hoy</option>
                  <option value="ayer">Ayer</option>
                  <option value="semana">Ultima semana</option>
                  <option value="todos">Todos del periodo</option>
                </select>
              </div>
            </div>
            <div class="mozos-registro-list" id="mozos-registro-list"></div>
          </section>
        </div>
        <section class="mozos-panel mozos-rendimiento-panel">
          <div class="mozos-panel-head">
            <div class="mozos-panel-titlebox">
              <span>Rendimiento por mozo</span>
              <small>Ventas, atencion y mesas cerradas</small>
            </div>
          </div>
          <div class="mozos-tabla-scroll mozos-rendimiento-scroll">
            <table class="mozos-tabla">
              <thead>
                <tr>
                  <th>Mozo</th>
                  <th class="num">Mesas cobradas</th>
                  <th class="num">Ventas cobradas</th>
                  <th class="num">Ticket prom.</th>
                  <th class="num">Pedidos entregados</th>
                  <th class="num">Llamados atendidos</th>
                  <th class="num">Resp. prom.</th>
                </tr>
              </thead>
              <tbody>
                ${filasVisibles.map(m => `
                  <tr>
                    <td>
                      <div class="mozo-identidad">
                        <span class="mozo-avatar">${escapeHtml(String(m.nombre || "M").charAt(0).toUpperCase())}</span>
                        <span>
                          <strong>${escapeHtml(m.nombre || "Mozo sin nombre")}</strong>
                          ${m.activo ? '<small>Mozo activo</small>' : '<small class="mozo-inactivo-text">Mozo inactivo</small>'}
                        </span>
                      </div>
                    </td>
                    <td class="num">${m.mesas_cerradas}</td>
                    <td class="num">${formatPrecio(m.ventas_cobradas)}</td>
                    <td class="num">${m.mesas_cerradas ? formatPrecio(m.ticket_promedio) : "—"}</td>
                    <td class="num">${m.pedidos_entregados}</td>
                    <td class="num">${m.llamados_atendidos}</td>
                    <td class="num">${resp(m)}</td>
                  </tr>`).join("")}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td class="num">${t.mesas_cerradas}</td>
                  <td class="num">${formatPrecio(t.ventas_cobradas)}</td>
                  <td class="num">${t.mesas_cerradas ? formatPrecio(ticketPromedioGeneral) : "—"}</td>
                  <td class="num">${t.pedidos_entregados}</td>
                  <td class="num">${t.llamados_atendidos}</td>
                  <td class="num">—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        <p class="reporte-note">El reporte muestra solo usuarios con rol mozo. Los administradores no se incluyen en este control operativo.</p>`;
      renderRegistroCobrosMozos("recientes");
      if (window.lucide) lucide.createIcons();
    }

    async function descargarReporteMozos(formato = "excel") {
      const r = _rangoMozos();
      if (!r) return;
      const ext = formato === "pdf" ? "pdf" : "xlsx";
      const label = formato === "pdf" ? "PDF" : "Excel";
      const btn = document.getElementById(`btn-mozos-${formato}`);
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> ${label}...`;
      try {
        await downloadFile(
          `/reportes/mozos?fecha_inicio=${r.inicio}&fecha_fin=${r.fin}&formato=${formato}`,
          `reporte_mozos_${r.inicio}_${r.fin}.${ext}`
        );
        mostrarToast(`Reporte ${label} descargado.`, "success");
      } catch (error) {
        mostrarToast("Error al descargar: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = formato === "pdf"
          ? '<i data-lucide="file-text"></i> PDF'
          : '<i data-lucide="file-spreadsheet"></i> Excel';
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
  
