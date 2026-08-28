
    // ── PROTECCIÓN DE RUTA ──────────────────────────────────────
    if (!requireAuth(ROLES.ADMIN, ROLES.MOZO)) throw new Error();
    applyRoleVisibility();

    const usuario = getUser();
    if (usuario) {
      document.getElementById("sidebar-username").textContent = usuario.nombre;
    }

    // ── ESTADO LOCAL ────────────────────────────────────────────
    let todasLasMesas   = [];
    let mapaMesas       = [];
    let mesaQRActual    = null;  // mesa abierta en el modal
    let mesaOperacionActual = null;
    let mapaTimer       = null;
    let mapaSignature   = "";
    let mapaCardSignatures = new Map();
    let socketMesas     = null;
    let cuentaDataActual = null;
    let metodoPagoSeleccionado = "efectivo";
    let qrPreviewUrls = new Map();
    let qrModalObjectUrl = null;
    let qrModalRequestId = 0;

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", () => {
      const tieneMapaSalon = Boolean(document.getElementById("salon-floor"));
      const tieneGestionQR = Boolean(document.getElementById("mesas-grid-container"));

      // GET /mesas (listado + gestión de QR) es solo-admin en el backend;
      // el mozo no ve esa sección, así que alcanza con el mapa del salón.
      if (getUserRole() === ROLES.ADMIN && tieneGestionQR) {
        cargarMesas();
      } else if (tieneMapaSalon) {
        cargarMapaMesas();
      }

      if (tieneMapaSalon) {
        conectarTiempoRealMesas();
        mapaTimer = setInterval(cargarMapaMesas, 2500);
      }

      const inputNumero = document.getElementById("input-numero");
      if (inputNumero) {
        inputNumero.addEventListener("keydown", e => {
          if (e.key === "Enter") crearMesa();
        });
      }
    });

    // ── CARGAR MESAS ────────────────────────────────────────────
    async function cargarMesas() {
      try {
        // GET /mesas — requiere token
        const data = await fetchAPI("/mesas");
        todasLasMesas = Array.isArray(data) ? data : [];
        actualizarStats(todasLasMesas);
        renderMesas(todasLasMesas);
        if (document.getElementById("salon-floor")) await cargarMapaMesas();
      } catch (error) {
        const container = document.getElementById("mesas-grid-container");
        if (container) container.innerHTML = `
          <div class="mesas-grid">
            <div class="empty-state">
              <div class="icon">️</div>
              <p>No se pudo cargar las mesas: ${escapeHtml(error.message)}</p>
            </div>
          </div>`;
        const label = document.getElementById("mesas-count-label");
        if (label) label.textContent = "Error al cargar";
      }
    }

    async function cargarMapaMesas() {
      try {
        const data = await fetchAPI("/mesas/mapa");
        mapaMesas = Array.isArray(data) ? data : [];
        renderMapaSalon(mapaMesas);
      } catch (error) {
        const floor = document.getElementById("salon-floor");
        if (floor) {
          floor.innerHTML = `
            <div class="empty-state">
              <div class="icon">Mapa</div>
              <p>No se pudo cargar el mapa: ${escapeHtml(error.message)}</p>
            </div>`;
        }
      }
    }

    // ── STATS ───────────────────────────────────────────────────
    function actualizarStats(mesas) {
      const total = document.getElementById("stat-total");
      const ultimaCreada = document.getElementById("stat-ultima");
      if (!total || !ultimaCreada) return;

      total.textContent = mesas.length;
      if (mesas.length > 0) {
        const ultima = mesas[mesas.length - 1];
        ultimaCreada.textContent = `Mesa ${ultima.numero}`;
      } else {
        ultimaCreada.textContent = "—";
      }
    }

    function renderMapaSalon(mesas) {
      const floor = document.getElementById("salon-floor");
      const updated = document.getElementById("salon-updated");
      const summary = document.getElementById("salon-summary");
      if (!floor) return;

      if (updated) {
        updated.textContent = `Actualizado ${new Date().toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit"
        })}`;
      }

      if (!mesas.length) {
        floor.innerHTML = `
          <div class="empty-state">
            <div class="icon">Mapa</div>
            <p>No hay mesas activas para mostrar.</p>
          </div>`;
        if (summary) summary.innerHTML = renderSalonSummary(0, 0, 0);
        return;
      }

      const activas = mesas.filter(m => m.estado_salon !== "libre").length;
      const esperando = mesas.filter(m => m.estado_salon === "esperando" || m.estado_salon === "pedido_activo" || m.estado_salon === "cuenta").length;
      const alertas = mesas.filter(m => m.estado_salon === "abandonada" || m.estado_salon === "esperando" || m.cuenta_solicitada || m.mozo_solicitado).length;
      if (summary) summary.innerHTML = renderSalonSummary(activas, esperando, alertas);

      const mesasOrdenadas = [...mesas].sort((a, b) => a.numero - b.numero);
      const maxPedidosHoy = Math.max(1, ...mesasOrdenadas.map(m => Number(m.pedidos_hoy) || 0));
      const layoutSignature = JSON.stringify(mesasOrdenadas.map(m => m.id_mesa));
      const tables = floor.querySelector(".salon-tables");

      if (layoutSignature === mapaSignature && tables) {
        mesasOrdenadas.forEach((mesa, index) => {
          const cardSignature = getMesaPlanoSignature(mesa, maxPedidosHoy);
          const currentSignature = mapaCardSignatures.get(mesa.id_mesa);
          if (cardSignature === currentSignature) return;

          const current = tables.querySelector(`[data-mesa-id="${mesa.id_mesa}"]`);
          const html = renderMesaPlano(mesa, index, maxPedidosHoy);
          if (current) {
            current.outerHTML = html;
          } else {
            tables.insertAdjacentHTML("beforeend", html);
          }
          mapaCardSignatures.set(mesa.id_mesa, cardSignature);
        });
        return;
      }

      mapaSignature = layoutSignature;
      mapaCardSignatures = new Map(mesasOrdenadas.map(mesa => [
        mesa.id_mesa,
        getMesaPlanoSignature(mesa, maxPedidosHoy),
      ]));

      floor.innerHTML = `
        <div class="salon-zone salon-zone-bar">Barra</div>
        <div class="salon-zone salon-zone-kitchen">Cocina</div>
        <div class="salon-zone salon-zone-entry">Entrada</div>
        <div class="salon-tables">
          ${mesasOrdenadas.map((mesa, index) => renderMesaPlano(mesa, index, maxPedidosHoy)).join("")}
        </div>`;
    }

    function getMesaPlanoSignature(mesa, maxPedidosHoy) {
      return JSON.stringify([
        mesa.id_mesa,
        mesa.numero,
        mesa.estado_salon,
        mesa.pedidos_activos,
        mesa.pendientes,
        mesa.confirmados,
        mesa.en_preparacion,
        mesa.listos,
        mesa.items_carrito,
        mesa.participantes,
        mesa.cuenta_solicitada,
        mesa.mozo_solicitado,
        mesa.minutos_espera,
        mesa.minutos_desde_scan,
        mesa.pedidos_hoy,
        maxPedidosHoy,
      ]);
    }

    function renderSalonSummary(activas, esperando, alertas) {
      return `
        <div class="salon-summary-item">
          <span>Activas</span>
          <strong>${activas}</strong>
        </div>
        <div class="salon-summary-item">
          <span>Esperando</span>
          <strong>${esperando}</strong>
        </div>
        <div class="salon-summary-item ${alertas > 0 ? "alert" : ""}">
          <span>Alertas</span>
          <strong>${alertas}</strong>
        </div>`;
    }

    function renderMesaPlano(mesa, index, maxPedidosHoy) {
      const estado = mesa.estado_salon || "libre";
      const heat = Math.min(1, (Number(mesa.pedidos_hoy) || 0) / maxPedidosHoy);
      const espera = mesa.minutos_espera != null ? `${mesa.minutos_espera} min` : "Sin espera";
      const participantes = Number(mesa.participantes) || 0;
      const carrito = Number(mesa.items_carrito) || 0;
      const pedidos = Number(mesa.pedidos_activos) || 0;
      const actividad = Number(mesa.pedidos_hoy) || 0;
      const estadoLabel = getEstadoMesaLabel(estado);
      const pedidoResumen = mesa.pendientes > 0
        ? `${mesa.pendientes} pendiente${mesa.pendientes === 1 ? "" : "s"}`
        : mesa.cuenta_solicitada
          ? "Cuenta solicitada"
          : `${pedidos} pedidos activos`;
      const alerta = estado === "abandonada"
        ? `<div class="mesa-alerta">Sin pedido hace ${mesa.minutos_desde_scan || 10} min</div>`
        : estado === "esperando"
          ? `<div class="mesa-alerta">Espera alta</div>`
          : mesa.cuenta_solicitada
            ? `<div class="mesa-alerta">Solicitó la cuenta</div>`
            : mesa.mozo_solicitado
              ? `<div class="mesa-alerta">Solicitó mozo</div>`
          : "";

      return `
        <button
          class="mesa-plano mesa-${estado}"
          data-mesa-id="${mesa.id_mesa}"
          style="--i:${index}; --heat:${heat.toFixed(2)}"
          type="button"
          onclick="abrirMesaOperacion(${mesa.id_mesa})"
          title="Mesa ${mesa.numero} — ${estadoLabel}"
        >
          <span class="mesa-heat"></span>
          <span class="mesa-top">
            <span class="mesa-status-dot"></span>
            <span class="mesa-status">${estadoLabel}</span>
          </span>
          <strong>Mesa ${escapeHtml(String(mesa.numero))}</strong>
          <span class="mesa-plano-meta">
            <span>${pedidoResumen}</span>
            <span>${carrito} items en carrito</span>
            <span>${participantes} personas</span>
          </span>
          <span class="mesa-plano-foot">
            <span>${espera}</span>
            <span>${actividad} hoy</span>
          </span>
          ${alerta}
        </button>`;
    }

    function getEstadoMesaLabel(estado) {
      const labels = {
        libre: "Libre",
        ocupada: "Ocupada",
        pidiendo: "Pidiendo",
        pedido_activo: "Ocupada",
        esperando: "Espera alta",
        cuenta: "Cuenta",
        abandonada: "Abandonada",
      };
      return labels[estado] || "Libre";
    }

    async function abrirMesaOperacion(idMesa) {
      mesaOperacionActual = idMesa;
      const overlay = document.getElementById("mesa-operacion-overlay");
      const body = document.getElementById("mesa-operacion-body");
      const title = document.getElementById("mesa-operacion-title");
      if (!overlay || !body || !title) return;

      overlay.classList.add("open");
      title.textContent = "Mesa";
      body.innerHTML = `
        <div class="empty-state">
          <div class="icon">Mesa</div>
          <p>Cargando detalle...</p>
        </div>`;

      try {
        const data = await fetchAPI(`/mesas/${idMesa}/operacion`);
        renderMesaOperacion(data);
      } catch (error) {
        body.innerHTML = `
          <div class="empty-state">
            <div class="icon">Error</div>
            <p>No se pudo cargar la mesa: ${escapeHtml(error.message)}</p>
          </div>`;
      }
    }

    function renderMesaOperacion(data) {
      const body = document.getElementById("mesa-operacion-body");
      const title = document.getElementById("mesa-operacion-title");
      const mesa = data.mesa || {};
      const pedidos = Array.isArray(data.pedidos) ? data.pedidos : [];
      title.textContent = `Mesa ${mesa.numero || "—"}`;

      // "Liberar mesa" cuando ya no queda nada por cobrar (data.cobrada, calculado
      // en el backend contra cierre_pedidos) pero el estado operativo sigue
      // ocupado. Cobro y entrega son ejes independientes: puede haber pedidos
      // sin entregar (mesa.tiene_pedidos_sin_entregar) y aun así liberarse.
      const puedeLiberar = data.cobrada && data.ocupada;

      body.innerHTML = `
        <div class="mesa-operacion-summary">
          <div>
            <span>Estado</span>
            <strong>${data.cuenta_solicitada ? "Cuenta solicitada" : data.mozo_solicitado ? "Mozo solicitado" : data.ocupada ? "Ocupada" : "Sin actividad"}</strong>
          </div>
          <div>
            <span>Pedidos del día</span>
            <strong>${pedidos.length}</strong>
          </div>
        </div>
        <div class="mesa-operacion-actions">
          ${data.mozo_solicitado
            ? `<button class="btn-ghost btn-service-done" type="button" onclick="atenderMozo(${mesa.id_mesa})">Mozo atendido</button>`
            : ""
          }
          ${puedeLiberar
            ? `${data.tiene_pedidos_sin_entregar
                ? `<div class="cobro-alerta">Mesa cobrada. Quedan pedidos por entregar en cocina.</div>`
                : ""
              }
               <button class="btn-cobrar" type="button" onclick="liberarMesa(${mesa.id_mesa})">Liberar mesa</button>`
            : `<button class="btn-cobrar" type="button" onclick="cobrarMesa(${mesa.id_mesa})">Cobrar mesa</button>`
          }
        </div>
        <div class="mesa-pedidos-list">
          ${pedidos.length
            ? pedidos.map(renderPedidoMesa).join("")
            : `<div class="empty-state mesa-empty"><p>Esta mesa no tiene pedidos activos del día.</p></div>`
          }
        </div>`;
    }

    function renderPedidoMesa(pedido) {
      const detalle = Array.isArray(pedido.detalle) ? pedido.detalle : [];
      const observaciones = (pedido.observaciones || "").trim();
      const grupos = agruparDetallePedido(detalle);
      let accion = "";
      if (getUserRole() === ROLES.MOZO) {
        if (pedido.estado !== "entregado" && pedido.estado !== "cancelado") {
          accion = `<button class="btn-primary mesa-action-primary" type="button" onclick="avanzarPedidoMesa(${pedido.id_pedido}, 'entregado')">Marcar entregado</button>`;
        }
      } else {
        accion = pedido.estado === "pendiente"
          ? `<button class="btn-primary mesa-action-primary" type="button" onclick="avanzarPedidoMesa(${pedido.id_pedido}, 'confirmado')">Confirmar pedido</button>`
          : pedido.estado === "listo"
            ? `<button class="btn-primary mesa-action-primary" type="button" onclick="avanzarPedidoMesa(${pedido.id_pedido}, 'entregado')">Entregar pedido</button>`
            : "";
      }
      const estadoClase = String(pedido.estado || "").replace(/_/g, "-");

      return `
        <article class="mesa-pedido-card estado-${estadoClase}">
          <button class="mesa-pedido-head" type="button" onclick="togglePedidoMesa(${pedido.id_pedido})">
            <div>
              <strong class="mesa-pedido-number">Pedido #${pedido.id_pedido}</strong>
              <span>
                <b>${escapeHtml(labelEstadoPedido(pedido.estado))}</b>
                · ${pedido.minutos_espera ?? 0} min
                ${observaciones ? " · Con observaciones" : ""}
              </span>
            </div>
            <div class="mesa-pedido-total">${formatPrecio(pedido.total)}</div>
          </button>
          <div class="mesa-pedido-detail" id="pedido-detalle-${pedido.id_pedido}">
            ${observaciones
              ? `<div class="mesa-pedido-observaciones">
                  <span>Observaciones</span>
                  <p>${escapeHtml(observaciones)}</p>
                </div>`
              : ""
            }
            ${renderGrupoPedidoMesa("Bebidas", grupos.bebidas, "bebidas")}
            ${renderGrupoPedidoMesa("Comida", grupos.comida, "comida")}
            ${accion ? `<div class="mesa-pedido-actions">${accion}</div>` : ""}
          </div>
        </article>`;
    }

    function renderGrupoPedidoMesa(titulo, items, tipo) {
      if (!items.length) return "";
      return `
        <section class="mesa-pedido-grupo mesa-pedido-grupo-${tipo}">
          <div class="mesa-pedido-grupo-title">${titulo}</div>
          <div class="mesa-pedido-items">
            ${items.map(item => `
              <div>
                <span>
                  ${escapeHtml(item.nombre)} x${item.cantidad}
                  ${item.subcategoria ? `<em>${escapeHtml(item.subcategoria)}</em>` : ""}
                </span>
                <strong>${formatPrecio(item.subtotal)}</strong>
              </div>
            `).join("")}
          </div>
        </section>`;
    }

    function agruparDetallePedido(detalle) {
      return detalle.reduce((acc, item) => {
        const destino = esBebida(item) ? "bebidas" : "comida";
        acc[destino].push(item);
        return acc;
      }, { bebidas: [], comida: [] });
    }

    function esBebida(item) {
      const texto = normalizarTexto([
        item.categoria,
        item.subcategoria,
        item.nombre,
      ].filter(Boolean).join(" "));
      return /bebida|bebidas|cerveza|cervezas|coctel|cocteleria|gin|tonic|whisky|champagne|gaseosa|agua|limonada|pomelada|naranjada|jugo|coca|sprite|tragos?|sin alcohol/.test(texto);
    }

    function normalizarTexto(texto) {
      return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    }

    function togglePedidoMesa(idPedido) {
      const detail = document.getElementById(`pedido-detalle-${idPedido}`);
      if (!detail) return;
      detail.classList.toggle("open");
    }

    async function avanzarPedidoMesa(idPedido, estado) {
      try {
        await fetchAPI(`/pedidos/${idPedido}/estado`, "PATCH", { estado });
        mostrarToast("Pedido actualizado.", "success");
        await cargarMapaMesas();
        if (mesaOperacionActual) await abrirMesaOperacion(mesaOperacionActual);
      } catch (error) {
        mostrarToast("No se pudo actualizar el pedido: " + error.message, "error");
      }
    }

    async function liberarMesa(idMesa) {
      try {
        await fetchAPI(`/mesas/${idMesa}/liberar`, "POST");
        document.querySelectorAll(".mesa-pedido-card").forEach(card => {
          card.classList.add("mesa-pedido-cobrada");
        });
        mostrarToast("Mesa marcada como cobrada y libre.", "success");
        await cargarMapaMesas();
      } catch (error) {
        mostrarToast("No se pudo liberar la mesa: " + error.message, "error");
      }
    }

    async function atenderMozo(idMesa) {
      try {
        await fetchAPI(`/mesas/${idMesa}/atender-mozo`, "POST");
        mostrarToast("Solicitud de mozo marcada como atendida.", "success");
        await cargarMapaMesas();
        if (mesaOperacionActual) await abrirMesaOperacion(mesaOperacionActual);
      } catch (error) {
        mostrarToast("No se pudo marcar la solicitud: " + error.message, "error");
      }
    }

    // ── COBRO DE MESA ───────────────────────────────────────

    async function cobrarMesa(idMesa) {
      const overlay = document.getElementById("cobro-overlay");
      const body = document.getElementById("cobro-body");
      const title = document.getElementById("cobro-title");

      metodoPagoSeleccionado = "efectivo";
      cuentaDataActual = null;

      overlay.classList.add("open");
      title.textContent = "Cargando cuenta...";
      body.innerHTML = `<div class="cobro-loading">Calculando cuenta...</div>`;

      try {
        const data = await fetchAPI(`/mesas/${idMesa}/cuenta`);
        cuentaDataActual = data;
        title.textContent = `Cobrar Mesa ${data.numero_mesa}`;
        renderModalCobro(data, idMesa);
      } catch (error) {
        body.innerHTML = `
          <div class="empty-state">
            <p>No se pudo cargar la cuenta: ${escapeHtml(error.message)}</p>
          </div>`;
      }
    }

    function renderModalCobro(data, idMesa) {
      const body = document.getElementById("cobro-body");
      const pedidos = Array.isArray(data.pedidos) ? data.pedidos : [];
      const total = data.total_consumido || 0;

      // Consolidar todos los items de todos los pedidos
      const itemsConsolidados = {};
      pedidos.forEach(pedido => {
        (pedido.items || []).forEach(item => {
          const key = item.id_producto;
          if (itemsConsolidados[key]) {
            itemsConsolidados[key].cantidad += item.cantidad;
            itemsConsolidados[key].subtotal += item.subtotal;
          } else {
            itemsConsolidados[key] = { ...item };
          }
        });
      });

      const itemsOrdenados = Object.values(itemsConsolidados)
        .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));

      const alertaPendientes = data.tiene_pendientes
        ? `<div class="cobro-alerta">Hay pedidos aún no entregados incluidos en esta cuenta.</div>`
        : "";

      const sinPedidos = pedidos.length === 0
        ? `<div class="cobro-sin-pedidos">Esta mesa no tiene pedidos para cobrar.</div>`
        : "";

      body.innerHTML = `
        ${alertaPendientes}
        ${sinPedidos}

        <div class="cobro-items-lista">
          ${itemsOrdenados.map(item => `
            <div class="cobro-item-row">
              <span class="cobro-item-nombre">${escapeHtml(item.nombre)} <em>x${item.cantidad}</em></span>
              <span class="cobro-item-precio">${formatPrecio(item.subtotal)}</span>
            </div>
          `).join("")}
        </div>

        <div class="cobro-total-row">
          <span>Total a cobrar</span>
          <strong class="cobro-total-monto">${formatPrecio(total)}</strong>
        </div>

        <div class="cobro-metodo-section">
          <div class="cobro-section-label">Método de pago</div>
          <div class="cobro-metodos">
            <button class="cobro-metodo-btn active" data-metodo="efectivo" type="button" onclick="seleccionarMetodoPago('efectivo')">Efectivo</button>
            <button class="cobro-metodo-btn" data-metodo="tarjeta" type="button" onclick="seleccionarMetodoPago('tarjeta')">Tarjeta</button>
            <button class="cobro-metodo-btn" data-metodo="qr" type="button" onclick="seleccionarMetodoPago('qr')">QR</button>
            <button class="cobro-metodo-btn" data-metodo="otro" type="button" onclick="seleccionarMetodoPago('otro')">Otro</button>
          </div>
        </div>

        <div class="cobro-efectivo-section" id="cobro-efectivo-section">
          <label class="cobro-section-label" for="cobro-monto-input">Monto recibido</label>
          <input
            class="cobro-monto-input"
            id="cobro-monto-input"
            type="number"
            min="0"
            step="1"
            placeholder="${Math.ceil(total)}"
            oninput="calcularVuelto(${total})"
          />
          <div class="cobro-vuelto-row" id="cobro-vuelto-row" style="display:none">
            <span>Vuelto</span>
            <strong id="cobro-vuelto-monto">—</strong>
          </div>
        </div>

        <div class="cobro-obs-section">
          <label class="cobro-section-label" for="cobro-obs">Observaciones (opcional)</label>
          <input class="cobro-obs-input" id="cobro-obs" type="text" maxlength="255" placeholder="Ej: pagó con billete de $10.000" />
        </div>

        <div class="cobro-footer">
          <button class="btn-ghost" type="button" onclick="cerrarCobro()">Cancelar</button>
          <button class="btn-cobrar-confirmar" id="cobro-confirmar-btn" type="button"
            onclick="confirmarCobro(${idMesa}, ${total})"
            ${pedidos.length === 0 ? "disabled" : ""}
          >Confirmar cobro</button>
        </div>`;
    }

    function seleccionarMetodoPago(metodo) {
      metodoPagoSeleccionado = metodo;
      document.querySelectorAll(".cobro-metodo-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.metodo === metodo);
      });
      const efectivoSection = document.getElementById("cobro-efectivo-section");
      if (efectivoSection) {
        efectivoSection.style.display = metodo === "efectivo" ? "" : "none";
      }
      if (metodo !== "efectivo") {
        const vueltoRow = document.getElementById("cobro-vuelto-row");
        if (vueltoRow) vueltoRow.style.display = "none";
      }
    }

    function calcularVuelto(totalConsumir) {
      const input = document.getElementById("cobro-monto-input");
      const vueltoRow = document.getElementById("cobro-vuelto-row");
      const vueltoMonto = document.getElementById("cobro-vuelto-monto");
      if (!input || !vueltoRow || !vueltoMonto) return;

      const monto = parseFloat(input.value) || 0;
      if (monto > 0) {
        const vuelto = Math.max(0, monto - totalConsumir);
        vueltoMonto.textContent = formatPrecio(vuelto);
        vueltoRow.style.display = "";
      } else {
        vueltoRow.style.display = "none";
      }
    }

    async function confirmarCobro(idMesa, totalConsumir) {
      const btn = document.getElementById("cobro-confirmar-btn");
      let montoCobrado = totalConsumir;

      if (metodoPagoSeleccionado === "efectivo") {
        const input = document.getElementById("cobro-monto-input");
        const valorInput = parseFloat(input ? input.value : 0);
        montoCobrado = valorInput > 0 ? valorInput : totalConsumir;
      }

      const observaciones = (document.getElementById("cobro-obs")?.value || "").trim() || null;

      if (btn) {
        btn.disabled = true;
        btn.textContent = "Registrando...";
      }

      try {
        const resultado = await fetchAPI(`/mesas/${idMesa}/cerrar`, "POST", {
          metodo_pago: metodoPagoSeleccionado,
          monto_cobrado: montoCobrado,
          observaciones,
        });

        cerrarCobro();
        cerrarMesaOperacion();
        if (resultado && resultado.entrega_pendiente) {
          mostrarToast("Cobro registrado y mesa liberada. Quedan pedidos por entregar en cocina.", "success");
        } else {
          mostrarToast("Mesa cobrada y liberada correctamente.", "success");
        }
        await cargarMapaMesas();
      } catch (error) {
        mostrarToast("No se pudo registrar el cobro: " + error.message, "error");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Confirmar cobro";
        }
      }
    }

    function cerrarCobro() {
      document.getElementById("cobro-overlay").classList.remove("open");
      cuentaDataActual = null;
      metodoPagoSeleccionado = "efectivo";
    }

    function cerrarCobroSiAfuera(event) {
      if (event.target === document.getElementById("cobro-overlay")) cerrarCobro();
    }

    function cerrarMesaOperacion() {
      document.getElementById("mesa-operacion-overlay").classList.remove("open");
      mesaOperacionActual = null;
    }

    function cerrarMesaOperacionSiAfuera(event) {
      if (event.target === document.getElementById("mesa-operacion-overlay")) cerrarMesaOperacion();
    }

    function labelEstadoPedido(estado) {
      const labels = {
        pendiente: "Pendiente",
        confirmado: "Confirmado",
        en_preparacion: "En preparación",
        listo: "Listo",
        entregado: "Entregado",
      };
      return labels[estado] || estado;
    }

    // ── RENDER GRID ─────────────────────────────────────────────
    function renderMesas(mesas) {
      const container = document.getElementById("mesas-grid-container");
      const label     = document.getElementById("mesas-count-label");
      limpiarPreviewQRs();

      label.textContent = mesas.length === 1 ? "1 mesa" : `${mesas.length} mesas`;

      if (mesas.length === 0) {
        container.innerHTML = `
          <div class="mesas-grid">
            <div class="empty-state">
              <div class="icon">Mesa</div>
              <p>No hay mesas todavía.<br>¡Creá la primera!</p>
            </div>
          </div>`;
        return;
      }

      const cards = mesas.map((mesa, i) => {
        // La URL del QR la arma el backend como: /mesas/{id}/qr
        const qrEndpoint = `/mesas/${mesa.id_mesa}/qr`;

        return `
          <div class="mesa-card" style="animation-delay: ${i * 0.05}s">
            <div class="mesa-numero-label">Mesa</div>
            <div class="mesa-numero">${escapeHtml(String(mesa.numero))}</div>
            ${mesa.qr_url
              ? `<img
                   id="qr-preview-${mesa.id_mesa}"
                   data-qr-endpoint="${escapeHtml(qrEndpoint)}"
                   src=""
                   class="mesa-qr-preview"
                   alt="QR Mesa ${mesa.numero}"
                   onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
                 <div class="mesa-qr-placeholder" style="display:none;">QR</div>`
              : `<div class="mesa-qr-placeholder">QR</div>`
            }
            <div class="mesa-actions">
              <button class="btn-ver-qr" onclick="verQR(${mesa.id_mesa}, ${mesa.numero}, '${escapeHtml(qrEndpoint)}')">
                Ver QR
              </button>
              <button class="btn-dl-qr" onclick="descargarQR('${escapeHtml(qrEndpoint)}', ${mesa.numero})">
                Descargar
              </button>
            </div>
          </div>`;
      }).join("");

      container.innerHTML = `<div class="mesas-grid">${cards}</div>`;
      cargarPreviewsQR();
    }

    function limpiarPreviewQRs() {
      qrPreviewUrls.forEach(url => URL.revokeObjectURL(url));
      qrPreviewUrls = new Map();
    }

    async function cargarPreviewsQR() {
      const imagenes = document.querySelectorAll("[data-qr-endpoint]");
      for (const img of imagenes) {
        const endpoint = img.dataset.qrEndpoint;
        if (!endpoint) continue;
        try {
          const objectUrl = await fetchFileObjectUrl(endpoint);
          qrPreviewUrls.set(img.id, objectUrl);
          img.src = objectUrl;
        } catch {
          img.style.display = "none";
          if (img.nextElementSibling) img.nextElementSibling.style.display = "flex";
        }
      }
    }

    // ── CREAR MESA ──────────────────────────────────────────────
    async function crearMesa() {
      const numero = parseInt(document.getElementById("input-numero").value);

      if (!numero || numero < 1) {
        mostrarToast("Ingresá un número de mesa válido.", "error");
        return;
      }

      // Verificar si el número ya existe
      const yaExiste = todasLasMesas.some(m => m.numero === numero);
      if (yaExiste) {
        mostrarToast(`La mesa ${numero} ya existe.`, "error");
        return;
      }

      const btn = document.getElementById("btn-crear");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Creando...';

      try {
        // POST /mesas — body: { numero }
        // El backend genera el QR automáticamente
        await fetchAPI("/mesas", "POST", { numero });
        mostrarToast(`Mesa ${numero} creada con QR generado.`, "success");
        document.getElementById("input-numero").value = "";
        await cargarMesas(); // recarga el grid
      } catch (error) {
        mostrarToast("Error al crear mesa: " + error.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = "Crear mesa";
      }
    }

    // ── VER QR EN MODAL ─────────────────────────────────────────
    async function verQR(idMesa, numero, qrEndpoint) {
      const requestId = ++qrModalRequestId;
      mesaQRActual = { idMesa, numero, qrEndpoint };

      document.getElementById("modal-qr-title").textContent = `QR — Mesa ${numero}`;
      const img = document.getElementById("modal-qr-img");
      img.removeAttribute("src");
      document.getElementById("modal-qr-url").textContent    =
        `${API_URL}/mesas/${idMesa}/qr`;

      document.getElementById("modal-overlay").classList.add("open");

      try {
        const objectUrl = await fetchFileObjectUrl(qrEndpoint);
        // Si mientras esperábamos la respuesta se abrió otra mesa en el modal,
        // esta respuesta quedó obsoleta: descartarla en vez de pisar la imagen
        // de la mesa que el usuario ya está viendo (condición de carrera si
        // dos "Ver QR" se clickean seguidos y las respuestas llegan desordenadas).
        if (requestId !== qrModalRequestId) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (qrModalObjectUrl) URL.revokeObjectURL(qrModalObjectUrl);
        qrModalObjectUrl = objectUrl;
        img.src = qrModalObjectUrl;
      } catch (error) {
        if (requestId === qrModalRequestId) {
          mostrarToast("No se pudo cargar el QR: " + error.message, "error");
        }
      }
    }

    // ── DESCARGAR QR DESDE MODAL ────────────────────────────────
    async function descargarQRModal() {
      if (!mesaQRActual) return;
      await descargarQR(mesaQRActual.qrEndpoint, mesaQRActual.numero);
    }

    // ── DESCARGAR QR DIRECTO DESDE CARD ─────────────────────────
    async function descargarQR(endpoint, numero) {
      try {
        // Usa downloadFile() de api.js que maneja el Bearer token
        await downloadFile(endpoint, `mesa_${numero}_qr.png`);
        mostrarToast(`QR de mesa ${numero} descargado.`, "success");
      } catch (error) {
        mostrarToast("Error al descargar el QR: " + error.message, "error");
      }
    }

    // ── HELPERS MODAL ───────────────────────────────────────────
    function cerrarModal() {
      document.getElementById("modal-overlay").classList.remove("open");
      if (qrModalObjectUrl) {
        URL.revokeObjectURL(qrModalObjectUrl);
        qrModalObjectUrl = null;
      }
      mesaQRActual = null;
    }

    function cerrarModalSiAfuera(event) {
      if (event.target === document.getElementById("modal-overlay")) cerrarModal();
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        cerrarCobro();
        cerrarModal();
        cerrarMesaOperacion();
      }
    });

    window.addEventListener("beforeunload", () => {
      if (mapaTimer) clearInterval(mapaTimer);
      limpiarPreviewQRs();
    });

    // ── TOAST ───────────────────────────────────────────────────
    let toastTimer;
    function mostrarToast(mensaje, tipo = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = mensaje;
      toast.className   = `toast ${tipo} show`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }

    // ── ESCAPE HTML ─────────────────────────────────────────────
    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function conectarTiempoRealMesas() {
      if (getUserRole() !== ROLES.ADMIN || !window.COCINA_DEVICE_TOKEN) return;
      const token = getToken();
      if (!token) return;

      const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
      const wsBase = API_URL.replace(/^https?:\/\//, "");
      socketMesas = new WebSocket(`${wsProtocol}://${wsBase}/pedidos/ws/cocina?device_token=${encodeURIComponent(window.COCINA_DEVICE_TOKEN)}`);

      socketMesas.addEventListener("message", (event) => {
        reproducirAviso();
        let data = {};
        try {
          data = JSON.parse(event.data);
        } catch {
          data = {};
        }

        if (data.type === "pedido_creado") {
          mostrarToast(data.message || "Nueva mesa envió un pedido.", "success");
        } else if (data.type === "servicio_mesa") {
          mostrarToast(data.message || "Nueva solicitud de mesa", "success");
        } else if (data.type === "pedido_actualizado") {
          mostrarToast("Pedido actualizado en cocina.", "success");
        }

        cargarMapaMesas();
        if (mesaOperacionActual) abrirMesaOperacion(mesaOperacionActual);
      });

      socketMesas.addEventListener("close", () => {
        setTimeout(conectarTiempoRealMesas, 4000);
      });
    }

    function reproducirAviso() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 740;
        gain.gain.value = 0.035;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.14);
      } catch {
        // El navegador puede bloquear audio si no hubo interacción.
      }
    }

    const formatterPrecio = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });

    function formatPrecio(valor) {
      return formatterPrecio.format(Number(valor) || 0);
    }
  
