// ============================================================
//  paginador.js — control de paginación reutilizable
//  Lo usan las secciones del panel admin que paginan del lado
//  del servidor (productos, inventario, usuarios).
//
//  renderPaginador("id-contenedor", {
//    page, pages, total, limit,
//    onPage: (nuevaPagina) => { ... }
//  });
// ============================================================

function renderPaginador(containerId, { page, pages, total, limit, onPage }) {
  const el = document.getElementById(containerId);
  if (!el) return;

  page = Math.max(1, Number(page) || 1);
  pages = Math.max(1, Number(pages) || 1);
  total = Math.max(0, Number(total) || 0);
  limit = Math.max(1, Number(limit) || 1);

  if (total === 0) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const desde = (page - 1) * limit + 1;
  const hasta = Math.min(page * limit, total);
  const numeros = _paginasVisibles(page, pages);

  const botones = pages <= 1
    ? ""
    : `
      <div class="pag-controls">
        <button type="button" class="pag-btn pag-nav" ${page <= 1 ? "disabled" : ""}
          data-page="${page - 1}" aria-label="Página anterior">‹</button>
        ${numeros.map(n => n === "..."
          ? `<span class="pag-ellipsis" aria-hidden="true">…</span>`
          : `<button type="button" class="pag-btn ${n === page ? "active" : ""}"
               data-page="${n}" ${n === page ? 'aria-current="page"' : ""}>${n}</button>`
        ).join("")}
        <button type="button" class="pag-btn pag-nav" ${page >= pages ? "disabled" : ""}
          data-page="${page + 1}" aria-label="Página siguiente">›</button>
      </div>`;

  el.innerHTML = `
    <span class="pag-info">${desde}–${hasta} de ${total}</span>
    ${botones}`;

  el.querySelectorAll(".pag-btn[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const destino = Number(btn.dataset.page);
      if (destino >= 1 && destino <= pages && destino !== page) onPage(destino);
    });
  });
}

// 1 … p-1 p p+1 … N  (sin repetir, con elipsis donde hay salto)
function _paginasVisibles(page, pages) {
  const set = new Set([1, pages, page, page - 1, page + 1]);
  const orden = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const salida = [];
  orden.forEach((n, i) => {
    if (i > 0 && n - orden[i - 1] > 1) salida.push("...");
    salida.push(n);
  });
  return salida;
}
