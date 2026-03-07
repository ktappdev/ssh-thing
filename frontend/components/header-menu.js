export function initHeaderMenu() {
  const menuWrap = document.getElementById("header-menu-wrap");
  const toggleBtn = document.getElementById("header-menu-toggle");
  const menu = document.getElementById("header-menu");

  if (!menuWrap || !toggleBtn || !menu) {
    return;
  }

  const setOpen = (open) => {
    menu.classList.toggle("hidden", !open);
    toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const isOpen = () => !menu.classList.contains("hidden");

  toggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!isOpen());
  });

  menu.addEventListener("click", (event) => {
    const action = event.target.closest("button");
    if (action) {
      setOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    if (!menuWrap.contains(event.target)) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  });
}
