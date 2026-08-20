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
    " No se detectó una mesa válida. Escaneá el QR de tu mesa.";
  document.getElementById("header-mesa").textContent = " Mesa inválida";
} else {
  document.getElementById("header-mesa").textContent = ` Mesa ${mesaNumero}`;
  document.getElementById("hero-sub").textContent    =
    `Mesa ${mesaNumero} — Elegí lo que querés y confirmá tu pedido`;
}

// ── ESTADO DEL CARRITO ──────────────────────────────────────
// Estructura: [{ id_producto, nombre, precio, cantidad }]
let carrito        = [];
let todosProductos = [];
let carritoAbierto = false;
let categoriaActual = null;
let busquedaActual = "";
let mesaSocket = null;
let mesaSocketListo = false;
let aplicandoCarritoRemoto = false;
let soyAnfitrion = true;
let participantesMesa = [];
let syncMesaTimer = null;
let recomendacionesInteligentes = [];
let idsPopularesHoy = new Set();
let contextoRecomendaciones = "";
let navCompactaActiva = false;
let scrollNavPendiente = false;
const mesaClientId = obtenerClientIdMesa();
const mesaClientName = obtenerNombreClienteMesa();

const formatterPrecio = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const carritoStorageKey = mesaValida ? `scanorder_carrito_mesa_${mesaNumero}` : null;
const categoriasMenu = [
  {
    nombre: "Comidas",
    descripcion: "Hamburguesas, combos y principales",
    imagen: "../assets/img/burguer.jpg",
    keywords: ["comida", "hamburguesa", "hamburguesas", "burger", "combo", "sandwich", "sanguche", "papas", "papa", "milanesa", "pizza", "empanada"],
    excludes: ["cerveza", "birra", "postre", "helado", "torta"],
  },
  {
    nombre: "Cervezas",
    descripcion: "Rubias, rojas, negras y tiradas",
    imagen: "../assets/img/Beer_Drink.jpg",
    keywords: ["cerveza", "cervezas", "pinta", "birra", "ipa", "lager", "stout", "rubia", "roja", "negra", "heineken", "quilmes", "corona", "stella", "andes", "patagonia", "brahma"],
    excludes: ["gaseosa", "limonada", "jugo", "agua", "postre"],
  },
  {
    nombre: "Coctelería",
    descripcion: "Tragos, aperitivos y bebidas de autor",
    imagen: "../assets/img/cocteleria.jpg",
    keywords: ["coctel", "cocteleria", "cocktail", "trago", "tragos", "gin", "vermut", "fernet", "aperol", "mojito", "limonada", "gaseosa", "jugo", "agua", "soda"],
    excludes: ["cerveza", "birra", "pinta", "ipa", "lager", "stout", "heineken", "quilmes", "corona"],
  },
  {
    nombre: "Postres",
    descripcion: "Opciones dulces para cerrar la mesa",
    imagen: "../assets/img/postres.jpg",
    keywords: ["postre", "postres", "dulce", "helado", "torta", "brownie", "flan", "panqueque"],
  },
];
const subcategoriasMenu = {
  Cocteleria: [
    {
      nombre: "Cocteleria tradicional",
      keywords: ["fernet", "aperol", "vermut", "campari", "mojito", "caipirinha", "negroni", "spritz", "trago", "clasico", "clásico"],
    },
    {
      nombre: "Sin alcohol",
      keywords: ["agua", "gaseosa", "coca", "sprite", "limonada", "jugo", "soda", "tonica", "tónica", "sin alcohol"],
    },
    {
      nombre: "Cocktails sin alcohol",
      keywords: ["mocktail", "cocktail sin alcohol", "coctel sin alcohol", "pomelada", "naranjada", "limonada de menta", "virgin"],
    },
    {
      nombre: "Cervezas",
      keywords: ["cerveza", "cervezas", "pinta", "birra", "ipa", "lager", "stout", "rubia", "roja", "negra"],
    },
    {
      nombre: "Whisky",
      keywords: ["whisky", "whiskey", "bourbon", "scotch"],
    },
    {
      nombre: "Champagne",
      keywords: ["champagne", "espumante", "prosecco"],
    },
  ],
};

// ── CARGAR MENÚ ─────────────────────────────────────────────
const subcategoriasMenuNuevo = {
  comidas: [
    {
      nombre: "Hamburguesas",
      keywords: ["hamburguesa", "hamburguesas", "burger", "maven classic", "maven doble", "maven bbq", "veggie", "spicy"],
    },
    {
      nombre: "Papas Fritas",
      keywords: ["papa", "papas", "frita", "fritas", "cheddar", "bacon"],
    },
    {
      nombre: "Entraditas",
      keywords: ["entrada", "entradita", "aros", "cebolla", "empanada", "bastones", "nuggets", "rabas"],
    },
    {
      nombre: "Pizzas",
      keywords: ["pizza", "pizzas", "muzza", "muzzarella", "napolitana", "fugazzeta"],
    },
  ],
  cocteleria: [
    {
      nombre: "Bebida sin alcohol",
      keywords: ["agua", "gaseosa", "coca", "sprite", "limonada", "jugo", "soda", "tonica", "tónica", "sin alcohol"],
    },
    {
      nombre: "Gin Tonic",
      keywords: ["gin", "tonic", "tonica", "tónica", "gin tonic" ]
    },
    {
      nombre: "Super Clasicos",
      keywords: ["fernet", "aperol", "vermut", "campari", "mojito", "caipirinha", "negroni", "spritz", "cuba libre", "gancia", "clasico", "clásico"],
    },
  ],
};

document.addEventListener("DOMContentLoaded", cargarMenu);
document.addEventListener("DOMContentLoaded", actualizarEspacioCarrito);
document.addEventListener("DOMContentLoaded", inicializarControlesPedido);
document.addEventListener("DOMContentLoaded", mostrarPromoEfectivo);
document.addEventListener("DOMContentLoaded", inicializarNavegacionCliente);
document.addEventListener("DOMContentLoaded", inicializarHeaderMenu);
document.addEventListener("DOMContentLoaded", inicializarScrollCategorias);
window.addEventListener("resize", actualizarEspacioCarrito);
window.addEventListener("scroll", programarActualizacionNavCompacta, { passive: true });

async function cargarMenu() {
  try {
    // GET /productos — ruta pública (auth=false)
    // El cliente no tiene token JWT
    const data = await fetchAPI("/productos", "GET", null, false);
    todosProductos = Array.isArray(data) ? data.filter(p => p.disponible) : [];

    if (todosProductos.length === 0) {
      document.getElementById("menu-container").innerHTML = `
        <div class="empty-state" style="padding-top:80px;">
          <div class="icon"></div>
          <p>El menú no está disponible por el momento.</p>
        </div>`;
      return;
    }

    await cargarInteligenciaMenu();
    restaurarCarritoGuardado();
    renderRecomendacionesInteligentes();
    renderCategorias();
    actualizarCarritoUI();
    inicializarSesionMesa();

  } catch (error) {
    document.getElementById("menu-container").innerHTML = `
      <div class="empty-state" style="padding-top:80px;">
        <div class="icon">️</div>
        <p>No se pudo cargar el menú.<br>
           <small style="color:#c4b49a;">${escapeHtml(error.message)}</small>
        </p>
      </div>`;
  }
}

// ── FILTROS POR CATEGORÍA ────────────────────────────────────
function getCategorias() {
  return categoriasMenu.map(categoria => categoria.nombre);
}

function getCategoriaConfig(nombre) {
  return categoriasMenu.find(categoria => categoria.nombre === nombre) || {
    nombre,
    descripcion: "Productos disponibles",
    keywords: [nombre],
  };
}

function getProductosPorCategoriaVisual(nombre) {
  const config = getCategoriaConfig(nombre);
  return todosProductos.filter(producto => {
    const texto = normalizarTexto(`${producto.categoria || ""} ${producto.nombre || ""} ${producto.descripcion || ""}`);
    const coincide = config.keywords.some(keyword => texto.includes(normalizarTexto(keyword)));
    const excluido = (config.excludes || []).some(keyword => texto.includes(normalizarTexto(keyword)));
    return coincide && !excluido;
  });
}

function renderCategorias() {
  categoriaActual = null;
  document.body.classList.remove("busqueda-activa");
  actualizarVistaCategoria(false);
  const recomendaciones = document.getElementById("smart-recs");
  if (recomendaciones && recomendacionesInteligentes.length > 0) {
    recomendaciones.style.display = "block";
  }
  const container = document.getElementById("menu-container");
  const termino = normalizarTexto(busquedaActual);
  const categorias = getCategorias()
    .map(cat => {
      const productos = getProductosPorCategoriaVisual(cat);
      return { cat, productos, config: getCategoriaConfig(cat) };
    })
    .filter(grupo => {
      if (!termino) return true;
      return normalizarTexto(`${grupo.cat} ${grupo.config.descripcion}`).includes(termino) ||
        grupo.productos.some(p => normalizarTexto(`${p.nombre || ""} ${p.descripcion || ""}`).includes(termino));
    });

  renderFiltros();
  renderHeaderMenuCategorias();

  if (categorias.length === 0) {
    container.innerHTML = `
      <div class="empty-state menu-empty">
        <div class="icon">Buscar</div>
        <p>No encontramos categorias o productos con esa busqueda.</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <section class="menu-section-shell">
      <div class="section-kicker">— Categorias</div>
      
      <div class="categorias-grid">
        ${categorias.map((grupo, i) => renderCategoriaCard(grupo.cat, grupo.productos, i, grupo.config)).join("")}
      </div>
    </section>`;
}

function renderCategoriaCard(categoria, productos, i, config = getCategoriaConfig(categoria)) {
  const destacado = productos.find(p => p.imagen_url) || productos[0] || {};
  const imagen = config.imagen || destacado.imagen_url;
  const descripcion = productos.length === 0
    ? "Pronto vas a poder ver esta seleccion"
    : productos.length === 1
      ? "1 producto disponible"
      : `${productos.length} productos disponibles`;
  const inicial = categoria.slice(0, 2).toUpperCase();
  return `
    <button class="categoria-card categoria-${normalizarTexto(categoria)}" style="animation-delay:${i * 0.04}s" onclick="abrirCategoria('${escapeAttr(categoria)}')">
      ${imagen
        ? `<img class="categoria-img" src="${escapeHtml(imagen)}" alt="${escapeHtml(categoria)}" loading="eager" decoding="async" fetchpriority="${i < 2 ? "high" : "auto"}">`
        : `<div class="categoria-img categoria-fallback">${escapeHtml(inicial)}</div>`
      }
      <span class="categoria-overlay"></span>
      <span class="categoria-count">${descripcion}</span>
      <span class="categoria-title">${escapeHtml(categoria)}</span>
      <span class="categoria-desc">${escapeHtml(config.descripcion)}</span>
      <span class="categoria-arrow" aria-hidden="true">→</span>
    </button>`;
}

function abrirCategoria(categoria) {
  categoriaActual = categoria;
  busquedaActual = "";
  const buscador = document.getElementById("buscador-productos");
  if (buscador) buscador.value = "";
  actualizarVistaCategoria(true);
  renderFiltros();
  renderHeaderMenuCategorias();
  aplicarFiltros();
  scrollAElemento("menu-container");
}

function volverACategorias() {
  busquedaActual = "";
  const buscador = document.getElementById("buscador-productos");
  if (buscador) buscador.value = "";
  actualizarVistaCategoria(false);
  renderCategorias();
  renderHeaderMenuCategorias();
  scrollAElemento("menu-container");
}

function renderFiltros() {
  const container = document.getElementById("filtros-container");
  if (!container) return;
  const categorias = getCategorias();
  container.innerHTML = `
    <button class="filtro-btn ${categoriaActual ? "" : "active"}" onclick="volverACategorias()">Categorias</button>
    ${categorias.map(cat => `
      <button class="filtro-btn ${categoriaActual === cat ? "active" : ""}" onclick="abrirCategoria('${escapeAttr(cat)}')">
        ${escapeHtml(cat)}
      </button>
    `).join("")}`;
}

function inicializarScrollCategorias() {
  const wrapper = document.getElementById("filtros-wrapper");
  if (!wrapper || wrapper.dataset.dragReady === "true") return;

  wrapper.dataset.dragReady = "true";
  let arrastrando = false;
  let seMovio = false;
  let inicioX = 0;
  let scrollInicial = 0;

  wrapper.addEventListener("pointerdown", (event) => {
    if (window.innerWidth > 620) return;
    arrastrando = true;
    seMovio = false;
    inicioX = event.clientX;
    scrollInicial = wrapper.scrollLeft;
    wrapper.classList.add("dragging");
  });

  wrapper.addEventListener("pointermove", (event) => {
    if (!arrastrando) return;
    const distancia = event.clientX - inicioX;
    if (Math.abs(distancia) > 4) {
      seMovio = true;
      wrapper.scrollLeft = scrollInicial - distancia;
      event.preventDefault();
    }
  }, { passive: false });

  const terminarArrastre = () => {
    arrastrando = false;
    wrapper.classList.remove("dragging");
  };

  wrapper.addEventListener("pointerup", terminarArrastre);
  wrapper.addEventListener("pointercancel", terminarArrastre);
  wrapper.addEventListener("pointerleave", terminarArrastre);

  wrapper.addEventListener("click", (event) => {
    if (!seMovio) return;
    event.preventDefault();
    event.stopPropagation();
    seMovio = false;
  }, true);
}

function aplicarFiltros() {
  if (!categoriaActual) {
    if (busquedaActual.trim()) {
      renderResultadosBusquedaGlobal();
      return;
    }
    renderCategorias();
    return;
  }

  renderMenu(getProductosFiltradosCategoriaActual());
}

function getProductosBusquedaGlobal() {
  const termino = normalizarTexto(busquedaActual);
  if (!termino) return [];

  return todosProductos.filter(producto => {
    const texto = normalizarTexto(`${producto.nombre || ""} ${producto.descripcion || ""} ${producto.categoria || ""} ${producto.subcategoria || ""}`);
    return texto.includes(termino);
  });
}

function renderResultadosBusquedaGlobal() {
  const container = document.getElementById("menu-container");
  const recomendaciones = document.getElementById("smart-recs");
  document.body.classList.add("busqueda-activa");
  if (recomendaciones) recomendaciones.style.display = "none";
  const termino = busquedaActual.trim();
  const productos = getProductosBusquedaGlobal();
  renderFiltros();

  if (productos.length === 0) {
    container.innerHTML = `
      <section class="search-results-view">
        ${renderSearchHero()}
        <div class="search-results-head">
          <span class="search-results-kicker">Resultados para</span>
          <h2>${escapeHtml(termino)}</h2>
        </div>
        <div class="subcategoria-empty">No hay productos cargados con esa busqueda.</div>
      </section>`;
    return;
  }

  const grupos = getCategorias()
    .map(categoria => ({
      categoria,
      productos: productos.filter(producto => getProductosPorCategoriaVisual(categoria).some(item => item.id_producto === producto.id_producto)),
    }))
    .filter(grupo => grupo.productos.length > 0);

  const productosSinGrupo = productos.filter(producto =>
    !grupos.some(grupo => grupo.productos.some(item => item.id_producto === producto.id_producto))
  );

  container.innerHTML = `
    <section class="search-results-view">
      ${renderSearchHero()}
      <div class="search-results-head">
        <span class="search-results-kicker">Resultados para</span>
        <h2>${escapeHtml(termino)}</h2>
      </div>
      <div class="search-results-list">
        ${grupos.map(grupo => `
          <section class="subcategoria-section search-result-group">
            <div class="subcategoria-header">
              <h3>${escapeHtml(grupo.categoria)}</h3>
            </div>
            <div class="productos-list">
              ${grupo.productos.map((p, i) => renderProductoCard(p, i)).join("")}
            </div>
          </section>
        `).join("")}
        ${productosSinGrupo.length
          ? `<section class="subcategoria-section search-result-group">
              <div class="subcategoria-header"><h3>Otros</h3></div>
              <div class="productos-list">
                ${productosSinGrupo.map((p, i) => renderProductoCard(p, i)).join("")}
              </div>
            </section>`
          : ""
        }
      </div>
    </section>`;
}

function renderSearchHero() {
  return `
    <div class="search-menu-topbar">
      <button class="search-back-btn" type="button" onclick="limpiarBusquedaGlobal()">
        <span aria-hidden="true">‹</span>
        Volver
      </button>
      <div class="search-menu-brand">Maven<span>Burger</span></div>
      <span></span>
    </div>
    <div class="search-menu-hero">
      <img src="../assets/img/local-maveburguer-optimized.jpg" alt="Maven Burger" loading="eager" decoding="async">
      <span class="search-menu-hero-overlay"></span>
      <h2>Maven <span>Burger</span></h2>
    </div>`;
}

function limpiarBusquedaGlobal() {
  busquedaActual = "";
  document.body.classList.remove("busqueda-activa");
  const buscador = document.getElementById("buscador-productos");
  if (buscador) buscador.value = "";
  renderCategorias();
  scrollAElemento("menu-container");
}

function renderMenu(productos) {
  const container = document.getElementById("menu-container");
  const categoria = categoriaActual || "Productos";
  const config = getCategoriaConfig(categoria);
  const imagenHero = config.imagen || productos.find(p => p.imagen_url)?.imagen_url || "../assets/img/local-maveburguer-optimized.jpg";
  container.innerHTML = `
    <section class="productos-view categoria-menu-view">
      <div class="categoria-menu-topbar">
        <button class="categoria-back-btn" type="button" onclick="volverACategorias()" aria-label="Volver a categorias">
          <span aria-hidden="true">‹</span>
          Volver
        </button>
        <div class="categoria-menu-brand">Maven<span>Burger</span></div>
        <button class="categoria-search-btn" type="button" onclick="toggleCategoriaSearch()" aria-label="Buscar en esta categoria">
          <span aria-hidden="true"></span>
        </button>
      </div>
      <div class="categoria-searchbar" id="categoria-searchbar">
        <input id="categoria-search-input" type="search" placeholder="Buscar en ${escapeAttr(categoria)}" value="${escapeAttr(busquedaActual)}" oninput="buscarEnCategoria(this.value)">
      </div>
      <div class="categoria-menu-hero">
        <img src="${escapeHtml(imagenHero)}" alt="${escapeHtml(categoria)}" loading="eager" decoding="async" fetchpriority="high">
        <span class="categoria-menu-hero-overlay"></span>
        <h2>${escapeHtml(capitalize(categoria))}</h2>
      </div>
      <div id="categoria-products-region">
        ${renderProductosCategoria(productos)}
      </div>
      <div class="categoria-menu-footer">Maven<span>Burger</span></div>
    </section>`;
}

function toggleCategoriaSearch() {
  const searchbar = document.getElementById("categoria-searchbar");
  const input = document.getElementById("categoria-search-input");
  if (!searchbar) return;
  const abierta = searchbar.classList.toggle("visible");
  if (abierta && input) input.focus();
}

function buscarEnCategoria(valor) {
  busquedaActual = valor || "";
  const productos = getProductosFiltradosCategoriaActual();
  const region = document.getElementById("categoria-products-region");
  if (region) {
    region.innerHTML = renderProductosCategoria(productos);
  } else {
    aplicarFiltros();
  }
  const searchbar = document.getElementById("categoria-searchbar");
  if (searchbar && busquedaActual) searchbar.classList.add("visible");
}

function getProductosFiltradosCategoriaActual() {
  const termino = normalizarTexto(busquedaActual);
  const productos = getProductosPorCategoriaVisual(categoriaActual);
  if (!termino) return productos;
  return productos.filter(p => {
    const texto = normalizarTexto(`${p.nombre || ""} ${p.descripcion || ""} ${p.categoria || ""} ${p.subcategoria || ""}`);
    return texto.includes(termino);
  });
}

function renderProductosCategoria(productos) {
  if (productos.length === 0) {
    return `<div class="empty-state menu-empty"><div class="icon">Buscar</div><p>No hay productos en esta categoria.</p></div>`;
  }

  const subcategorias = getSubcategoriasCategoria(categoriaActual);
  if (!subcategorias) {
    return `
      <div class="subcategoria-list categoria-simple-list">
        <section class="subcategoria-section">
          <div class="productos-list">
            ${productos.map((p, i) => renderProductoCard(p, i)).join("")}
          </div>
        </section>
      </div>`;
  }

  const grupos = agruparProductosPorSubcategoria(productos, subcategorias);
  return `
    <div class="subcategoria-list">
      <div class="subcategoria-tabs">
        ${grupos.map(grupo => `
          <a href="#subcat-${slugify(grupo.nombre)}">${escapeHtml(grupo.nombre)}</a>
        `).join("")}
      </div>
      ${grupos.map(grupo => `
        <section class="subcategoria-section" id="subcat-${slugify(grupo.nombre)}">
          <div class="subcategoria-header">
            <h3>${escapeHtml(grupo.nombre)}</h3>
          </div>
          <div class="productos-list">
            ${grupo.productos.length
              ? grupo.productos.map((p, i) => renderProductoCard(p, i)).join("")
              : `<div class="subcategoria-empty">Todavia no hay productos cargados en esta seccion.</div>`
            }
          </div>
        </section>
      `).join("")}
    </div>
  `;
}

function getSubcategoriasCategoria(categoria) {
  const clave = normalizarTexto(categoria);
  if (clave.includes("comida")) return subcategoriasMenuNuevo.comidas;
  if (clave.includes("cocteler") || clave.includes("cocktail")) return subcategoriasMenuNuevo.cocteleria;
  return subcategoriasMenuNuevo[clave] || subcategoriasMenu[clave] || subcategoriasMenu[categoria] || null;
}

function agruparProductosPorSubcategoria(productos, subcategorias) {
  const usados = new Set();
  const grupos = subcategorias
    .map(subcategoria => {
      const items = productos.filter(producto => {
        if (usados.has(producto.id_producto)) return false;
        const subcategoriaManual = normalizarTexto(producto.subcategoria);
        if (subcategoriaManual) {
          const coincideManual = subcategoriaManual === normalizarTexto(subcategoria.nombre);
          if (coincideManual) usados.add(producto.id_producto);
          return coincideManual;
        }
        const texto = normalizarTexto(`${producto.nombre || ""} ${producto.descripcion || ""} ${producto.categoria || ""}`);
        const coincide = subcategoria.keywords.some(keyword => texto.includes(normalizarTexto(keyword)));
        if (coincide) usados.add(producto.id_producto);
        return coincide;
      });
      return { nombre: subcategoria.nombre, productos: items };
    });

  const otros = productos.filter(producto => !usados.has(producto.id_producto));
  if (otros.length > 0) {
    grupos.push({ nombre: "Otros", productos: otros });
  }

  return grupos;
}

function actualizarVistaCategoria(enCategoria) {
  document.body.classList.toggle("categoria-activa", enCategoria);

  [
    "mesa-actions",
    "mesa-session-panel",
    "menu-tools",
    "smart-recs",
    "filtros-wrapper",
  ].forEach(id => {
    const elemento = document.getElementById(id);
    if (!elemento) return;
    elemento.classList.toggle("vista-oculta", enCategoria);
  });
  cerrarHeaderMenu();
}

function inicializarNavegacionCliente() {
  document.querySelectorAll("[data-scroll-target]").forEach(link => {
    link.addEventListener("click", event => {
      const target = link.getAttribute("data-scroll-target");
      if (!target) return;
      event.preventDefault();
      if (target === "menu-container" && categoriaActual) {
        volverACategorias();
        return;
      }
      if (target !== "menu-container" && categoriaActual) {
        volverACategorias();
        window.setTimeout(() => scrollAElemento(target), 80);
        return;
      }
      scrollAElemento(target);
    });
  });
}

function inicializarHeaderMenu() {
  renderHeaderMenuCategorias();

  document.querySelectorAll("[data-menu-categorias]").forEach(button => {
    button.addEventListener("click", () => {
      document.body.classList.toggle("header-categorias-open");
    });
  });

  document.querySelectorAll("[data-menu-scroll]").forEach(button => {
    button.addEventListener("click", () => {
      const target = button.getAttribute("data-menu-scroll");
      cerrarHeaderMenu();
      if (!target) return;

      if (target === "menu-container" && categoriaActual) {
        volverACategorias();
        return;
      }

      if (target !== "menu-container" && categoriaActual) {
        volverACategorias();
        window.setTimeout(() => scrollAElemento(target), 80);
        return;
      }

      scrollAElemento(target);
    });
  });

  document.addEventListener("click", event => {
    const panel = document.getElementById("header-menu-panel");
    const button = document.getElementById("header-menu-btn");
    if (!panel || !button || !document.body.classList.contains("header-menu-open")) return;
    if (panel.contains(event.target) || button.contains(event.target)) return;
    cerrarHeaderMenu();
  });

  actualizarModoNavCompacta();
}

function renderHeaderMenuCategorias() {
  const container = document.getElementById("header-menu-cats");
  if (!container) return;

  container.innerHTML = `
    <button type="button" onclick="volverACategorias(); cerrarHeaderMenu();">Ver todas</button>
    ${getCategorias().map(cat => `
      <button type="button" class="${categoriaActual === cat ? "active" : ""}" onclick="abrirCategoria('${escapeAttr(cat)}'); cerrarHeaderMenu();">
        ${escapeHtml(capitalize(cat))}
      </button>
    `).join("")}
  `;
}

function toggleHeaderMenu() {
  const abierto = !document.body.classList.contains("header-menu-open");
  document.body.classList.toggle("header-menu-open", abierto);
  const panel = document.getElementById("header-menu-panel");
  const button = document.getElementById("header-menu-btn");
  if (panel) panel.setAttribute("aria-hidden", abierto ? "false" : "true");
  if (button) button.setAttribute("aria-expanded", abierto ? "true" : "false");
}

function cerrarHeaderMenu() {
  document.body.classList.remove("header-menu-open");
  document.body.classList.remove("header-categorias-open");
  const panel = document.getElementById("header-menu-panel");
  const button = document.getElementById("header-menu-btn");
  if (panel) panel.setAttribute("aria-hidden", "true");
  if (button) button.setAttribute("aria-expanded", "false");
}

function programarActualizacionNavCompacta() {
  if (scrollNavPendiente) return;
  scrollNavPendiente = true;
  window.requestAnimationFrame(() => {
    scrollNavPendiente = false;
    actualizarModoNavCompacta();
  });
}

function actualizarModoNavCompacta() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const debeActivarse = navCompactaActiva ? y > 80 : y > 160;
  if (debeActivarse === navCompactaActiva) return;

  navCompactaActiva = debeActivarse;
  document.body.classList.toggle("nav-compacta", navCompactaActiva);

  if (!navCompactaActiva) {
    cerrarHeaderMenu();
  }
}

function scrollAElemento(id) {
  const elemento = document.getElementById(id);
  if (!elemento) return;

  const header = document.querySelector(".header")?.offsetHeight || 0;
  const nav = document.querySelector(".cliente-nav:not(.vista-oculta)")?.offsetHeight || 0;
  const filtrosEl = document.getElementById("filtros-wrapper");
  const filtros = filtrosEl && !filtrosEl.classList.contains("vista-oculta") ? filtrosEl.offsetHeight : 0;
  const offset = header + nav + filtros + 14;
  const top = elemento.getBoundingClientRect().top + window.scrollY - offset;

  window.scrollTo({
    top: Math.max(0, top),
    behavior: "smooth",
  });
}

function productoSinStock(producto) {
  return producto && producto.stock_actual !== null && producto.stock_actual !== undefined && Number(producto.stock_actual) <= 0;
}

function productoPuedePedirse(producto) {
  return Boolean(producto && producto.disponible && !productoSinStock(producto));
}

function renderProductoCard(p, i) {
  const enCarrito = carrito.find(c => c.id_producto === p.id_producto);
  const cantidad  = enCarrito ? enCarrito.cantidad : 0;
  const agotado = productoSinStock(p);
  const badges = agotado
    ? [{ texto: "Sin stock", tipo: "agotado" }, ...obtenerBadgesProducto(p)]
    : obtenerBadgesProducto(p);

  return `
    <div class="producto-card producto-row ${agotado ? "producto-agotado" : ""}" style="animation-delay:${i * 0.04}s" id="card-${p.id_producto}">
      <div class="producto-info">
        <div class="producto-nombre">${escapeHtml(p.nombre)}</div>
        ${badges.length
          ? `<div class="producto-badges">${badges.map(b => `<span class="producto-badge ${b.tipo}">${escapeHtml(b.texto)}</span>`).join("")}</div>`
          : ""
        }
        ${p.descripcion
          ? `<div class="producto-desc">${escapeHtml(p.descripcion)}</div>`
          : `<div class="producto-desc muted">Sin descripcion disponible</div>`
        }
      </div>

      <div class="producto-side">
        <div class="producto-precio">${formatPrecio(p.precio)}</div>
        <div class="cantidad-control" id="ctrl-${p.id_producto}">
          ${agotado
            ? `<button class="btn-cantidad sin-stock" type="button" disabled>Sin stock</button>`
            : cantidad === 0
            ? `<button class="btn-cantidad" onclick="agregarAlCarrito(${p.id_producto})">+</button>`
            : `<button class="btn-cantidad minus" onclick="quitarDelCarrito(${p.id_producto})">-</button>
               <span class="cantidad-num">${cantidad}</span>
               <button class="btn-cantidad" onclick="agregarAlCarrito(${p.id_producto})">+</button>`
          }
        </div>
      </div>
    </div>`;
}

// ── RECOMENDACIONES INTELIGENTES ─────────────────────────────
async function cargarInteligenciaMenu() {
  const [populares, clima] = await Promise.all([
    cargarPopularesHoy(),
    obtenerClimaActual(),
  ]);

  idsPopularesHoy = new Set(populares.map(p => p.id_producto));
  recomendacionesInteligentes = construirRecomendaciones(populares, clima);
  contextoRecomendaciones = construirContextoRecomendaciones(clima);
}

async function cargarPopularesHoy() {
  try {
    const data = await fetchAPI("/productos/populares-hoy", "GET", null, false);
    return Array.isArray(data.productos) ? data.productos : [];
  } catch {
    return [];
  }
}

async function obtenerClimaActual() {
  try {
    if (navigator.geolocation) {
      const posicion = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 3200,
          maximumAge: 15 * 60 * 1000,
        });
      });
      return consultarClimaOpenMeteo(posicion.coords.latitude, posicion.coords.longitude);
    }
  } catch {
    // Si el celular no permite ubicacion por HTTP local, usamos Buenos Aires como fallback.
  }

  return consultarClimaOpenMeteo(-34.6037, -58.3816);
}

async function consultarClimaOpenMeteo(latitude, longitude) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    return data.current_weather || null;
  } catch {
    return null;
  }
}

function construirRecomendaciones(populares, clima) {
  const recomendaciones = [];
  const usados = new Set();
  const hora = new Date().getHours();

  const agregar = (producto, motivo, badge, prioridad) => {
    if (!productoPuedePedirse(producto) || usados.has(producto.id_producto)) return;
    usados.add(producto.id_producto);
    recomendaciones.push({ producto, motivo, badge, prioridad });
  };

  const temp = clima && typeof clima.temperature === "number" ? clima.temperature : null;
  if (temp !== null && temp >= 28) {
    agregar(buscarProductoPorTexto(["bebida", "gaseosa", "agua", "limonada", "cerveza", "fria", "fría"]), `${Math.round(temp)}° ahora: ideal para algo bien frio.`, "Clima caluroso", 95);
  } else if (temp !== null && temp <= 16) {
    agregar(buscarProductoPorTexto(["cafe", "café", "chocolate", "caliente", "combo", "burger"]), `${Math.round(temp)}° ahora: conviene algo mas contundente.`, "Clima fresco", 95);
  }

  const promo = obtenerPromoHorario(hora);
  promo.keywords.forEach((keywords, index) => {
    agregar(buscarProductoPorTexto(keywords), promo.motivo, promo.badge, 86 - index);
  });

  populares.slice(0, 3).forEach((popular, index) => {
    const producto = todosProductos.find(p => p.id_producto === popular.id_producto) || popular;
    agregar(producto, `${popular.total_pedido || 1} pedidos hoy en Maven Burger.`, "Popular ahora", 90 - index);
  });

  if (recomendaciones.length < 4) {
    getProductosDestacables().slice(0, 4).forEach((producto, index) => {
      agregar(producto, "Buena opcion para completar el pedido de la mesa.", "Recomendacion para vos", 60 - index);
    });
  }

  return recomendaciones
    .sort((a, b) => b.prioridad - a.prioridad)
    .slice(0, 5);
}

function renderRecomendacionesInteligentes() {
  const section = document.getElementById("smart-recs");
  const grid = document.getElementById("smart-recs-grid");
  const context = document.getElementById("smart-recs-context");
  if (!section || !grid || recomendacionesInteligentes.length === 0) return;

  section.style.display = "block";
  if (context) context.textContent = contextoRecomendaciones;
  grid.innerHTML = recomendacionesInteligentes.map((rec, i) => renderRecomendacionCard(rec, i)).join("");
}

function renderRecomendacionCard(rec, i) {
  const p = rec.producto;
  const cantidad = carrito.find(c => c.id_producto === p.id_producto)?.cantidad || 0;
  const agotado = productoSinStock(p);
  return `
    <article class="smart-card ${agotado ? "smart-card-agotada" : ""}" style="animation-delay:${i * 0.05}s">
      <div class="smart-card-top">
        <span class="smart-badge">${escapeHtml(agotado ? "Sin stock" : rec.badge)}</span>
        <span class="smart-price">${formatPrecio(p.precio)}</span>
      </div>
      <h3>${escapeHtml(p.nombre)}</h3>
      <p>${escapeHtml(rec.motivo)}</p>
      <div class="smart-card-actions">
        <span>${escapeHtml(capitalize(p.categoria || "Menu"))}</span>
        ${agotado
          ? `<button type="button" disabled>Sin stock</button>`
          : cantidad === 0
          ? `<button type="button" onclick="agregarAlCarrito(${p.id_producto})">Agregar</button>`
          : `<button type="button" onclick="agregarAlCarrito(${p.id_producto})">Sumar otro</button>`
        }
      </div>
    </article>`;
}

function obtenerPromoHorario(hora) {
  if (hora >= 8 && hora < 11) {
    return {
      badge: "Promo mañana",
      motivo: "Franja desayuno: va perfecto con algo para arrancar liviano.",
      keywords: [["cafe", "café", "bebida"], ["tostado", "postre", "combo"]],
    };
  }
  if (hora >= 12 && hora < 16) {
    return {
      badge: "Promo almuerzo",
      motivo: "Horario fuerte de almuerzo: comida y bebida rinden mejor juntas.",
      keywords: [["combo"], ["hamburguesa", "burger"], ["bebida", "gaseosa"]],
    };
  }
  if (hora >= 16 && hora < 20) {
    return {
      badge: "Promo tarde",
      motivo: "Tarde de mesa: una bebida o algo dulce suma sin armar un pedido pesado.",
      keywords: [["bebida", "limonada", "gaseosa"], ["postre", "helado"]],
    };
  }
  return {
    badge: "Promo noche",
    motivo: "Noche Maven: combos y burgers salen rapido para compartir.",
    keywords: [["combo"], ["hamburguesa", "burger"], ["papas", "acompanamiento"]],
  };
}

function construirContextoRecomendaciones(clima) {
  const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  if (clima && typeof clima.temperature === "number") {
    return `${Math.round(clima.temperature)}° ahora · ${hora} · datos en vivo`;
  }
  return `${hora} · basado en horario, promos y pedidos de hoy`;
}

function buscarProductoPorTexto(keywords) {
  return todosProductos.find(producto => {
    if (!productoPuedePedirse(producto)) return false;
    const texto = normalizarTexto(`${producto.nombre || ""} ${producto.descripcion || ""} ${producto.categoria || ""}`);
    return keywords.some(keyword => texto.includes(normalizarTexto(keyword)));
  });
}

function getProductosDestacables() {
  return todosProductos.filter(productoPuedePedirse).sort((a, b) => {
    const aScore = Number(idsPopularesHoy.has(a.id_producto)) + Number(/combo|burger|hamburguesa/i.test(`${a.nombre} ${a.categoria}`));
    const bScore = Number(idsPopularesHoy.has(b.id_producto)) + Number(/combo|burger|hamburguesa/i.test(`${b.nombre} ${b.categoria}`));
    return bScore - aScore;
  });
}

function agregarAlCarrito(idProducto) {
  const producto = todosProductos.find(p => p.id_producto === idProducto);
  if (!producto) return;
  if (!productoPuedePedirse(producto)) {
    mostrarAvisoMesa("Este producto no tiene stock disponible por el momento.");
    return;
  }

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

  const producto = todosProductos.find(p => p.id_producto === idProducto);
  if (productoSinStock(producto)) {
    ctrl.innerHTML = `<button class="btn-cantidad sin-stock" type="button" disabled>Sin stock</button>`;
    return;
  }

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
    bar.classList.remove("visible", "expanded");
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
  renderRecomendacionesInteligentes();
}

// ── TOGGLE DEL CARRITO ───────────────────────────────────────
function toggleCarrito() {
  carritoAbierto = !carritoAbierto;
  const bar = document.getElementById("carrito-bar");
  if (bar) bar.classList.toggle("expanded", carritoAbierto);
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

  const btnFinal = document.getElementById("btn-enviar-final");
  if (btnFinal) {
    btnFinal.disabled = false;
    btnFinal.innerHTML = "Enviar a cocina";
  }

  document.getElementById("confirmacion-overlay").classList.add("visible");
}

function cerrarConfirmacion() {
  const btnFinal = document.getElementById("btn-enviar-final");
  if (btnFinal) {
    btnFinal.disabled = false;
    btnFinal.innerHTML = "Enviar a cocina";
  }
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
  // { id_mesa: int, productos: [{ id_producto, cantidad }], observaciones-: str }
  const body = {
    id_mesa: mesaNumero,
    qr_token: qrToken,
    productos: carrito.map(c => ({
      id_producto: c.id_producto,
      cantidad:    c.cantidad
    })),
    observaciones: obtenerObservaciones() || null,
    client_id: mesaClientId
  };

  try {
    // POST /pedidos — sin token (cliente no tiene cuenta)
    await fetchAPI("/pedidos", "POST", body, false);
    cerrarConfirmacion();
    carrito = [];
    setObservaciones("", { force: true });
    limpiarCarritoGuardado();
    limpiarSesionMesa();
    actualizarCarritoUI();
    todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
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
     <strong>Mesa ${mesaNumero}</strong> — En breve estará listo. `;
  document.getElementById("exito-overlay").classList.add("visible");
}

// ── VOLVER AL MENÚ DESPUÉS DEL PEDIDO ───────────────────────
function volverAlMenu() {
  // Limpiar carrito
  carrito = [];
  setObservaciones("", { force: true });
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
  setObservaciones("", { force: true });
  limpiarCarritoGuardado();
  cerrarConfirmacion();
  actualizarCarritoUI();
  todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
  sincronizarCarritoMesa();
}

// ── SESION COLABORATIVA DE MESA ──────────────────────────────
function inicializarSesionMesa() {
  actualizarPanelSesion("Conectando con el pedido compartido...", "Conectando", 1);
  if (!mesaValida) {
    actualizarPanelSesion("Escanea el QR de tu mesa para compartir el pedido.", "Sin mesa", 1, true);
    return;
  }

  const wsProtocol = API_URL.startsWith("https") ? "wss" : "ws";
  const wsBase = API_URL.replace(/^https?:\/\//, "");
  const url = `${wsProtocol}://${wsBase}/pedidos/ws/mesa?mesa=${mesaNumero}` +
    `&token=${encodeURIComponent(qrToken || "")}` +
    `&client_id=${encodeURIComponent(mesaClientId)}` +
    `&nombre=${encodeURIComponent(mesaClientName)}`;

  try {
    mesaSocket = new WebSocket(url);
  } catch {
    actualizarPanelSesion("No se pudo iniciar el pedido colaborativo.", "Sin conexion", 1, true);
    return;
  }

  mesaSocket.addEventListener("open", () => {
    mesaSocketListo = true;
  });

  mesaSocket.addEventListener("message", (event) => {
    try {
      aplicarSnapshotMesa(JSON.parse(event.data));
    } catch {
      // Ignora mensajes que no tengan formato esperado.
    }
  });

  mesaSocket.addEventListener("close", () => {
    mesaSocketListo = false;
    actualizarPanelSesion("Pedido colaborativo desconectado. Tu carrito queda en este celular.", "Sin conexion", participantesMesa.length || 1, true);
  });
}

function aplicarSnapshotMesa(data) {
  if (!data || !["snapshot", "carrito_actualizado", "participantes_actualizados", "pedido_confirmado"].includes(data.type)) {
    return;
  }

  participantesMesa = Array.isArray(data.participantes) ? data.participantes : [];
  soyAnfitrion = true;

  if (data.type === "snapshot" && (!data.carrito || data.carrito.length === 0) && carrito.length > 0) {
    sincronizarCarritoMesa();
    actualizarPanelSesion("Pedido compartido de mesa activo.", "Mesa", Math.max(participantesMesa.length, 1));
    return;
  }

  if (data.type === "pedido_confirmado") {
    aplicandoCarritoRemoto = true;
    carrito = [];
    setObservaciones("", { force: true });
    limpiarCarritoGuardado();
    aplicandoCarritoRemoto = false;
    actualizarCarritoUI();
    todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
    mostrarAvisoMesa("El pedido de la mesa ya fue enviado a cocina.");
  } else if (Array.isArray(data.carrito)) {
    aplicandoCarritoRemoto = true;
    carrito = normalizarCarritoRemoto(data.carrito);
    setObservaciones(data.observaciones || "");
    aplicandoCarritoRemoto = false;
    actualizarCarritoUI();
    todosProductos.forEach(p => actualizarControlCantidad(p.id_producto));
  }

  const totalParticipantes = Math.max(participantesMesa.length, 1);
  actualizarPanelSesion("Pedido compartido de mesa activo.", "Mesa", totalParticipantes);
}

function normalizarCarritoRemoto(items) {
  return items
    .map(item => {
      const producto = todosProductos.find(p => p.id_producto === item.id_producto);
      if (!productoPuedePedirse(producto)) return null;
      return {
        id_producto: producto.id_producto,
        nombre: producto.nombre,
        precio: Number(producto.precio),
        cantidad: Math.max(1, Number(item.cantidad) || 1),
      };
    })
    .filter(Boolean);
}

function sincronizarCarritoMesa() {
  if (!mesaSocketListo || !mesaSocket || mesaSocket.readyState !== WebSocket.OPEN || aplicandoCarritoRemoto) {
    return;
  }

  window.clearTimeout(syncMesaTimer);
  syncMesaTimer = window.setTimeout(() => {
    mesaSocket.send(JSON.stringify({
      action: "sync_cart",
      carrito: carrito.map(item => ({
        id_producto: item.id_producto,
        nombre: item.nombre,
        precio: Number(item.precio),
        cantidad: item.cantidad,
      })),
      observaciones: obtenerObservaciones(),
    }));
  }, 120);
}

function limpiarSesionMesa() {
  if (mesaSocketListo && mesaSocket && mesaSocket.readyState === WebSocket.OPEN) {
    mesaSocket.send(JSON.stringify({ action: "clear_cart" }));
  }
}

function actualizarPanelSesion(titulo, rol, cantidad, offline = false) {
  const titleEl = document.getElementById("session-title");
  const roleEl = document.getElementById("session-role");
  const countEl = document.getElementById("session-count");
  if (!titleEl || !roleEl || !countEl) return;

  titleEl.textContent = titulo;
  roleEl.textContent = rol;
  roleEl.className = offline ? "offline" : "host";
  countEl.textContent = cantidad === 1 ? "1 persona" : `${cantidad} personas`;
}

async function solicitarServicioMesa(tipo) {
  if (!mesaValida) {
    alert("Escanea el QR de tu mesa para usar esta opcion.");
    return;
  }

  const texto = tipo === "cuenta" ? "pedir la cuenta" : "llamar al mozo";
  try {
    await fetchAPI("/pedidos/servicio", "POST", {
      id_mesa: mesaNumero,
      tipo,
      qr_token: qrToken,
    }, false);
    mostrarAvisoMesa(`Solicitud enviada: ${texto}.`);
  } catch (error) {
    alert("No se pudo enviar la solicitud: " + error.message);
  }
}

function mostrarAvisoMesa(mensaje) {
  let aviso = document.getElementById("mesa-aviso");
  if (!aviso) {
    aviso = document.createElement("div");
    aviso.id = "mesa-aviso";
    aviso.className = "mesa-aviso";
    document.body.appendChild(aviso);
  }

  aviso.textContent = mensaje;
  aviso.classList.add("visible");
  window.clearTimeout(aviso._timer);
  aviso._timer = window.setTimeout(() => aviso.classList.remove("visible"), 3200);
}

// ── HELPERS ──────────────────────────────────────────────────
function mostrarPromoEfectivo() {
  const overlay = document.getElementById("promo-overlay");
  if (!overlay) return;

  const storageKey = mesaValida ? `scanorder_promo_efectivo_mesa_${mesaNumero}` : "scanorder_promo_efectivo";
  if (sessionStorage.getItem(storageKey) === "vista") return;

  window.setTimeout(() => {
    overlay.classList.add("visible");
    overlay.setAttribute("aria-hidden", "false");
  }, 350);
}

function cerrarPromoEfectivo() {
  const overlay = document.getElementById("promo-overlay");
  if (!overlay) return;

  const storageKey = mesaValida ? `scanorder_promo_efectivo_mesa_${mesaNumero}` : "scanorder_promo_efectivo";
  sessionStorage.setItem(storageKey, "vista");
  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden", "true");
}

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
  if (!mesaValida) {
    btn.innerHTML = "Escanea el QR de tu mesa";
  } else {
    btn.innerHTML = "Confirmar pedido";
  }
}

function actualizarEspacioCarrito() {
  const bar = document.getElementById("carrito-bar");
  if (!bar) return;

  const altura = bar.classList.contains("visible") && bar.classList.contains("expanded")
    ? bar.offsetHeight
    : 0;
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
    observaciones.addEventListener("focus", () => {
      const bar = document.getElementById("carrito-bar");
      if (bar) bar.classList.add("editing-notes");
    });
    observaciones.addEventListener("blur", () => {
      const bar = document.getElementById("carrito-bar");
      if (bar) bar.classList.remove("editing-notes");
      guardarCarrito();
    });
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
        if (!productoPuedePedirse(producto)) return null;
        return {
          id_producto: producto.id_producto,
          nombre: producto.nombre,
          precio: Number(producto.precio),
          cantidad: Math.max(1, Number(item.cantidad) || 1)
        };
      })
      .filter(Boolean);

    setObservaciones(guardado.observaciones || "", { force: true });
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
    sincronizarCarritoMesa();
    return;
  }

  localStorage.setItem(carritoStorageKey, JSON.stringify(payload));
  sincronizarCarritoMesa();
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

function setObservaciones(valor, options = {}) {
  const el = document.getElementById("pedido-observaciones");
  if (!el) return;

  if (!options.force && document.activeElement === el) {
    return;
  }

  const nuevoValor = valor || "";
  if (el.value === nuevoValor) return;

  el.value = nuevoValor;
}

function obtenerClientIdMesa() {
  const key = "scanorder_mesa_client_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `cliente_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function obtenerNombreClienteMesa() {
  const key = "scanorder_mesa_client_name";
  let nombre = localStorage.getItem(key);
  if (!nombre) {
    nombre = `Cliente ${mesaClientId.slice(-4).toUpperCase()}`;
    localStorage.setItem(key, nombre);
  }
  return nombre;
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
  if (idsPopularesHoy.has(producto.id_producto)) {
    badges.push({ texto: "Popular ahora", tipo: "popular" });
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
  if (cat.includes("hamburguesa") || cat.includes("burger")) return "";
  if (cat.includes("papa") || cat.includes("acompan")) return "";
  if (cat.includes("bebida")) return "";
  if (cat.includes("postre")) return "";
  if (cat.includes("combo")) return "";
  return "";
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

function slugify(valor) {
  return normalizarTexto(valor)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#096;");
}
