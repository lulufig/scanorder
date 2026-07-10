// Abre/cierra el drawer del sidebar en mobile/tablet (breakpoint en
// admin-shell.css). En desktop estas clases no tienen efecto visual
// porque el sidebar ya está siempre visible.
function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  if (sidebar) sidebar.classList.toggle("open");
  if (overlay) overlay.classList.toggle("visible");
}

function closeSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  if (sidebar) sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("visible");
}
