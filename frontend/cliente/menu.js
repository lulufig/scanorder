// ── ESTA PÁGINA ES PÚBLICA — no requiere login ──────────────
// El cliente escanea el QR y entra directo, sin autenticarse

// ── LEER MESA DESDE LA URL ──────────────────────────────────
// El QR apunta a: /cliente/menu.html?mesa=3
const params = new URLSearchParams(window.location.search);
const mesaId = params.get("mesa");
const qrToken = params.get("token");
const mesaNumero = obtenerMesaValida(mesaId);
const mesaValida = mesaNumero !== null;

if (!mesaValida) {
  document.getElementById("hero-sub").textContent =
    "⚠ No se detectó una mesa válida. Escaneá el QR de tu mesa.";
  document.getElementById("header-mesa").textContent = "🪑 Mesa inválida";
} else {
  document.getElementById("header-mesa").textContent = `🪑 Mesa ${mesaNumero}`;
  document.getElementById("hero-sub").textContent    =
    `Mesa ${mesaNumero} — Elegí lo que querés y confirmá tu pedido`;
}

// ── ESTADO DEL CARRITO ──────────────────────────────────────
// Estructura: [{ id_producto, nombre, precio, cantidad }]
let carrito        = [];
let todosProductos = [];
let carritoAbierto = false;
let categoriaActual = "todos";
let busquedaActual = "";

const formatterPrecio = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const carritoStorageKey = mesaValida ? `scanorder_carrito_mesa_${mesaNumero}` : null;

// ── CARGAR MENÚ ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", cargarMenu);
document.addEventListener("DOMContentLoaded", actualizarEspacioCarrito);
document.addEventListener("DOMContentLoaded", inicializarControlesPedido);
window.addEventListener("resize", actualizarEspacioCarrito);

async function cargarMenu() {
  try {
    // GET /productos — ruta pública (auth=false)
    // El cliente no tiene token JWT
    const data = await fetchAPI("/productos", "GET", null, false);
    todosProductos = Array.isArray(data) ? data.filter(p => p.disponible) : [];

    if (todosProductos.length === 0) {
      document.getElementById("menu-container").innerHTML = `
        <div class="empty-state" style="padding-top:80px;">
          <div class="icon">🍔</div>
          <p>El menú no está disponible por el momento.</p>
        </div>`;
      return;
    }

    construirFiltros(todosProductos);
    restaurarCarritoGuardado();
    aplicarFiltros();
    actualizarCarritoUI();

  } catch (error) {
    document.getElementById("menu-container").innerHTML = `
      <div class="empty-state" style="padding-top:80px;">
        <div class="icon">⚠️</div>
        <p>No se pudo cargar el menú.<br>
           <small style="color:#c4b49a;">${escapeHtml(error.message)}</small>
        </p>
      </div>`;
  }
}

// ── FILTROS POR CATEGORÍA ────────────────────────────────────
function construirFiltros(productos) {
  const categorias = [...new Set(productos.map(p => p.categoria).filter(Boolean))];
  const container = document.getElementById("filtros-container");
  categorias.forEach(cat => {
    const btn = document.createElement("button");
    btn.className   = "filtro-btn";
    btn.textContent = `${iconoCategoria(cat)} ${capitalize(cat)}`;
    btn.onclick     = () => filtrarCategoria(cat, btn);
    container.appendChild(btn);
  });
}

function filtrarCategoria(categoria, btnEl) {
  document.querySelectorAll(".filtro-btn").forEach(b => b.classList.remove("active"));
  btnEl.classList.add("active");
  categoriaActual = categoria;
  aplicarFiltros();
}

function aplicarFiltros() {
  const termino = normalizarTexto(busquedaActual);

  const porCategoria = categoriaActual === "todos"
    ? todosProductos
    : todosProductos.filter(p => p.categoria === categoriaActual);

  const filtrados = !termino
    ? porCategoria
    : porCategoria.filter(p => {
        const texto = normalizarTexto(`${p.nombre || ""} ${p.descripcion || ""} ${p.categoria || ""}`);
        return texto.includes(termino);
      });

  renderMenu(filtrados);
}

// ── RENDER DEL MENÚ ──────────────────────────────────────────
function renderMenu(productos) {
  const container = document.getElementById("menu-container");

  if (productos.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding-top:60px;">
        <div class="icon">🔍</div>
        <p>No hay productos en esta categoría.</p>
      </div>`;
    return;
  }

  // Agrupar por categoría
  const grupos = {};
  productos.forEach(p => {
    const cat = p.categoria || "otros";
    if (!grupos[cat]) grupos[cat] = [];
    grupos[cat].push(p);
  });

  let html = "";
  Object.entries(grupos).forEach(([cat, items]) => {
    html += `
      <div class="seccion">
        <div class="seccion-titulo">${iconoCategoria(cat)} ${capitalize(cat)}</div>
        <div class="productos-grid">
          ${items.map((p, i) => renderProductoCard(p, i)).join("")}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

function renderProductoCard(p, i) {
  const enCarrito = carrito.find(c => c.id_producto === p.id_producto);
  const cantidad  = enCarrito ? enCarrito.cantidad : 0;
  const badges = obtenerBadgesProducto(p);

  return `
    <div class="producto-card" style="animation-delay:${i * 0.04}s" id="card-${p.id_producto}">
      ${p.imagen_url
        ? `<img src="${escapeHtml(p.imagen_url)}" class="producto-img"
                alt="${escapeHtml(p.nombre)}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">`
        : ""
      }
      <div class="producto-img-placeholder" ${p.imagen_url ? 'style="display:none"' : ""}>🍔</div>

      <div class="producto-info">
        <div class="producto-nombre">${escapeHtml(p.nombre)}</div>
        ${badges.length
          ? `<div class="producto-badges">${badges.map(b => `<span class="producto-badge ${b.tipo}">${escapeHtml(b.texto)}</span>`).join("")}</div>`
          : ""
        }
        ${p.descripcion
          ? `<div class="producto-desc">${escapeHtml(p.descripcion)}</div>`
          : ""
        }
        <div class="producto-precio">${formatPrecio(p.precio)}</div>
      </div>

      <div class="cantidad-control" id="ctrl-${p.id_producto}">
        ${cantidad === 0
          ? `<button class="btn-cantidad" onclick="agregarAlCarrito(${p.id_producto})">+</button>`
          : `<button class="btn-cantidad minus" onclick="quitarDelCarrito(${p.id_producto})">−</button>
             <span class="cantidad-num">${cantidad}</span>
             <button class="btn-cantidad" onclick="agregarAlCarrito(${p.id_producto})">+</button>`
        }
      </div>
    </div>`;
}

// ── CARRITO: AGREGAR ─────────────────────────────────────────
function agregarAlCarrito(idProducto) {
  const producto = todosProductos.find(p => p.id_producto === idProducto);
  if (!producto) return;

  const existente = carrito.find(c => c.id_producto === idProducto);
  if (existente) {
    existente.cantidad++;
  } else {
    carrito.push({
      id_producto: producto.id_producto,
      nombre:      producto.nombre,
      precio:      producto.precio,
      cantidad:    1
    });
  }

  actualizarControlCantidad(idProducto);
  actualizarCarritoUI();
  guardarCarrito();
}

// ── CARRITO: QUITAR ──────────────────────────────────────────
function quitarDelCarrito(idProducto) {
  const existente = carrito.find(c => c.id_producto === idProducto);
  if (!existente) return;

  existente.cantidad--;
  if (existente.cantidad <= 0) {
    carrito = carrito.filter(c => c.id_producto !== idProducto);
  }

  actualizarControlCantidad(idProducto);
  actualizarCarritoUI();
  guardarCarrito();
}

// ── ACTUALIZAR BOTONES DE CANTIDAD EN LA CARD ────────────────
function actualizarControlCantidad(idProducto) {
  const ctrl    = document.getElementById(`ctrl-${idProducto}`);
  if (!ctrl) return;

  const item    = carrito.find(c => c.id_producto === idProducto);
  const cantidad = item ? item.cantidad : 0;

  ctrl.innerHTML = cantidad === 0
    ? `<button class="btn-cantidad" onclick="agregarAlCarrito(${idProducto})">+</button>`
    : `<button class="btn-cantidad minus" onclick="quitarDelCarrito(${idProducto})">−</button>
       <span class="cantidad-num">${cantidad}</span>
       <button class="btn-cantidad" onclick="agregarAlCarrito(${idProducto})">+</button>`;
}

// ── ACTUALIZAR UI DEL CARRITO ────────────────────────────────
function actualizarCarritoUI() {
  const total    = carrito.reduce((acc, c) => acc + c.precio * c.cantidad, 0);
  const cantidad = carrito.reduce((acc, c) => acc + c.cantidad, 0);
  const bar      = document.getElementById("carrito-bar");

  // Mostrar u ocultar la barra
  if (cantidad > 0) {
    bar.classList.add("visible");
  } else {
    bar.classList.remove("visible");
    carritoAbierto = false;
    document.getElementById("carrito-detalle").classList.remove("open");
  }

  document.getElementById("carrito-badge").textContent     = cantidad;
  document.getElementById("carrito-total-mini").textContent = formatPrecio(total);
  document.getElementById("carrito-items-label").textContent =
    cantidad === 1 ? "1 producto" : `${cantidad} productos`;

  // Renderizar lista del detalle
  const lista = document.getElementById("carrito-items-lista");
  lista.innerHTML = carrito.map(item => `
    <div class="carrito-item">
      <div>
        <div class="carrito-item-nombre">${escapeHtml(item.nombre)}</div>
        <div class="carrito-item-detalle">
          ${item.cantidad} × ${formatPrecio(item.precio)}
        </div>
      </div>
      <div class="carrito-item-sub">${formatPrecio(item.precio * item.cantidad)}</div>
    </div>
  `).join("");

  actualizarEstadoBotonConfirmar();
  actualizarEspacioCarrito();
}

// ── TOGGLE DEL CARRITO ───────────────────────────────────────
function toggleCarrito() {
  carritoAbierto = !carritoAbierto;
  document.getElementById("carrito-detalle").classList.toggle("open", carritoAbierto);
  actualizarEspacioCarrito();
}

// ── CONFIRMAR PEDIDO ─────────────────────────────────────────
function confirmarPedido() {
  if (carrito.length === 0) return;

  if (!mesaValida) {
    alert("No se detectó una mesa válida. Escaneá el QR de tu mesa.");
    return;
  }

  mostrarConfirmacion();
}

function mostrarConfirmacion() {
  const total = carrito.reduce((acc, c) => acc + c.precio * c.cantidad, 0);
  const observaciones = obtenerObservaciones();

  document.getElementById("confirmacion-mesa").textContent = `Mesa ${mesaNumero}`;
  document.getElementById("confirmacion-lista").innerHTML = carrito.map(item => `
    <div class="confirmacion-item">
      <span>${escapeHtml(item.nombre)} ×${item.cantidad}</span>
      <span>${formatPrecio(item.precio * item.cantidad)}</span>
    </div>
  `).join("");
  document.getElementById("confirmacion-total").textContent = formatPrecio(total);

  const notas = document.getElementById("confirmacion-notas");
  if (observaciones) {
    notas.style.display = "block";
    notas.innerHTML = `<strong>Observaciones:</strong><br>${escapeHtml(observaciones)}`;
  } else {
    notas.style.display = "none";
    notas.innerHTML = "";
  }

  document.getElementById("confirmacion-overlay").classList.add("visible");
}

function cerrarConfirmacion() {
  document.getElementById("confirmacion-overlay").classList.remove("visible");
}

async function enviarPedidoConfirmado() {
  const btn = document.getElementById("btn-confirmar");
  const btnFinal = document.getElementById("btn-enviar-final");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enviando pedido...';
  btnFinal.disabled = true;
  btnFinal.innerHTML = '<span class="spinner"></span> Enviando';

  // Body que espera el backend:
  // { id_mesa: int, productos: [{ id_producto, cantidad }], observaciones?: str }
  const body = {
    id_mesa: mesaNumero,
    qr_token: qrToken,
    productos: carrito.map(c => ({
      id_producto: c.id_producto,
      cantidad:    c.cantidad
    })),
    observaciones: obtenerObservaciones() || null
  };

  try {
    // POST /pedidos — sin token (cliente no tiene cuenta)
    await fetchAPI("/pedidos", "POST", body, false);
    cerrarConfirmacion();
    limpiarCarritoGuardado();
    mostrarExito();
  } catch (error) {
    alert("No se pudo enviar el pedido: " + error.message);
    actualizarEstadoBotonConfirmar();
    btnFinal.disabled = false;
    btnFinal.innerHTML = "Enviar a cocina";
  }
}

// ── PANTALLA DE ÉXITO ────────────────────────────────────────
function mostrarExito() {
  document.getElementById("exito-msg").innerHTML =
    `Tu pedido fue enviado a cocina.<br>
     <strong>Mesa ${mesaNumero}</strong> — En breve estará listo. 🍔`;
  document.getElementById("exito-overlay").classList.add("visible");
}

// ── VOLVER AL MENÚ DESPUÉS DEL PEDIDO ───────────────────────
function volverAlMenu() {
  // Limpiar carrito
  carrito = [];
  setObservaciones("");
  limpiarCarritoGuardado();
  actualizarCarritoUI();

  // Ocultar pantalla de éxito
  document.getElementById("exito-overlay").classList.remove("visible");

  // Resetear botón
  actualizarEstadoBotonConfirmar();

  // Volver al inicio de la página
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Resetear cards de cantidad
  todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
}

function vaciarCarrito() {
  carrito = [];
  setObservaciones("");
  limpiarCarritoGuardado();
  cerrarConfirmacion();
  actualizarCarritoUI();
  todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
}

// ── HELPERS ──────────────────────────────────────────────────
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function obtenerMesaValida(valor) {
  if (!/^[1-9]\d*$/.test(valor || "")) return null;
  return Number(valor);
}

function actualizarEstadoBotonConfirmar() {
  const btn = document.getElementById("btn-confirmar");
  if (!btn) return;

  btn.classList.toggle("invalid", !mesaValida);
  btn.disabled = !mesaValida;
  btn.innerHTML = mesaValida
    ? "🛒 Confirmar pedido"
    : "Escaneá el QR de tu mesa";
}

function actualizarEspacioCarrito() {
  const bar = document.getElementById("carrito-bar");
  if (!bar) return;

  const altura = bar.classList.contains("visible") ? bar.offsetHeight : 0;
  document.documentElement.style.setProperty("--cart-h", `${altura}px`);

  if (carritoAbierto) {
    window.setTimeout(actualizarEspacioCarrito, 320);
  }
}

function inicializarControlesPedido() {
  const buscador = document.getElementById("buscador-productos");
  if (buscador) {
    buscador.addEventListener("input", (event) => {
      busquedaActual = event.target.value;
      aplicarFiltros();
    });
  }

  const observaciones = document.getElementById("pedido-observaciones");
  if (observaciones) {
    observaciones.addEventListener("input", guardarCarrito);
  }
}

function restaurarCarritoGuardado() {
  if (!carritoStorageKey) return;

  try {
    const raw = localStorage.getItem(carritoStorageKey);
    if (!raw) return;

    const guardado = JSON.parse(raw);
    const items = Array.isArray(guardado.carrito) ? guardado.carrito : [];
    carrito = items
      .map(item => {
        const producto = todosProductos.find(p => p.id_producto === item.id_producto);
        if (!producto) return null;
        return {
          id_producto: producto.id_producto,
          nombre: producto.nombre,
          precio: Number(producto.precio),
          cantidad: Math.max(1, Number(item.cantidad) || 1)
        };
      })
      .filter(Boolean);

    setObservaciones(guardado.observaciones || "");
  } catch {
    limpiarCarritoGuardado();
  }
}

function guardarCarrito() {
  if (!carritoStorageKey) return;

  const payload = {
    carrito: carrito.map(item => ({
      id_producto: item.id_producto,
      cantidad: item.cantidad
    })),
    observaciones: obtenerObservaciones()
  };

  if (payload.carrito.length === 0 && !payload.observaciones) {
    limpiarCarritoGuardado();
    return;
  }

  localStorage.setItem(carritoStorageKey, JSON.stringify(payload));
}

function limpiarCarritoGuardado() {
  if (carritoStorageKey) {
    localStorage.removeItem(carritoStorageKey);
  }
}

function obtenerObservaciones() {
  const el = document.getElementById("pedido-observaciones");
  return el ? el.value.trim() : "";
}

function setObservaciones(valor) {
  const el = document.getElementById("pedido-observaciones");
  if (el) el.value = valor;
}

function obtenerBadgesProducto(producto) {
  const texto = normalizarTexto(`${producto.nombre || ""} ${producto.descripcion || ""} ${producto.categoria || ""}`);
  const badges = [];

  if (producto.nuevo || texto.includes("nuevo")) {
    badges.push({ texto: "Nuevo", tipo: "nuevo" });
  }
  if (producto.mas_pedido || producto.destacado || /maven classic|double maven|bbq/.test(texto)) {
    badges.push({ texto: "Más pedido", tipo: "popular" });
  }
  if (producto.picante || /picante|jalapeno|jalapenos|jalapeño|jalapeños/.test(texto)) {
    badges.push({ texto: "Picante", tipo: "picante" });
  }
  if (producto.combo || /combo|combos/.test(texto)) {
    badges.push({ texto: "Combo", tipo: "combo" });
  }

  return badges.slice(0, 3);
}

function iconoCategoria(categoria) {
  const cat = normalizarTexto(categoria);
  if (cat.includes("hamburguesa") || cat.includes("burger")) return "🍔";
  if (cat.includes("papa") || cat.includes("acompan")) return "🍟";
  if (cat.includes("bebida")) return "🥤";
  if (cat.includes("postre")) return "🍨";
  if (cat.includes("combo")) return "📦";
  return "🍽";
}

function formatPrecio(valor) {
  return formatterPrecio.format(Number(valor) || 0);
}

function normalizarTexto(valor) {
  return String(valor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
