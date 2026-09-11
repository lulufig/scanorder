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

const SIDEBAR_COLLAPSED_KEY = "scanorder_sidebar_collapsed";

function refreshSidebarDesktopToggle(button) {
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  button.setAttribute("aria-label", collapsed ? "Mostrar menú lateral" : "Ocultar menú lateral");
  button.setAttribute("title", collapsed ? "Mostrar menú" : "Ocultar menú");
  button.innerHTML = collapsed
    ? '<i data-lucide="panel-left-open"></i>'
    : '<i data-lucide="panel-left-close"></i>';

  if (window.lucide) lucide.createIcons();
}

function toggleDesktopSidebar() {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  const button = document.querySelector(".sidebar-desktop-toggle");
  if (button) refreshSidebarDesktopToggle(button);
}

function initDesktopSidebarToggle() {
  if (!document.querySelector(".sidebar") || document.querySelector(".sidebar-desktop-toggle")) return;

  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
    document.body.classList.add("sidebar-collapsed");
  }

  const button = document.createElement("button");
  button.className = "sidebar-desktop-toggle";
  button.type = "button";
  button.addEventListener("click", toggleDesktopSidebar);
  document.body.appendChild(button);
  refreshSidebarDesktopToggle(button);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDesktopSidebarToggle);
} else {
  initDesktopSidebarToggle();
}
