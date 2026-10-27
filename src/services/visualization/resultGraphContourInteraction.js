import { graphContourSelection, sameContourSurface } from "./resultGraphContours.js";

/** Clicks choose rows; drags remain camera gestures. No pointer capture is retained. */
export function installGraphContourInteraction({ element, blocked, pick, getSelection, onSelection,
  onMenu, onPreview, menuElement }) {
  const document = element.ownerDocument;
  let down = null, menu = null;
  const close = () => { menu = null; onMenu(null); onPreview(null); };
  const plain = event => !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const moved = event => !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
  function pointerdown(event) {
    down = { x: event.clientX, y: event.clientY, button: event.button, dragged: false };
    if (blocked() || !plain(event) || event.button !== 2) return;
    if (pick(event)) stop(event); // Keep OrbitControls out of a graph's right-click gesture.
  }
  function pointermove(event) {
    if (down && event.buttons && moved(event)) { down.dragged = true; if (menu) close(); }
  }
  function contextmenu(event) {
    if (blocked() || !plain(event) || (down?.button === 2 && (down.dragged || moved(event)))) return;
    const hit = pick(event);
    if (!hit) { close(); return; }
    stop(event);
    const bounds = element.getBoundingClientRect();
    menu = { hit, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    onPreview(null); onMenu(menu);
  }
  function click(event) {
    if (blocked() || !plain(event) || event.button !== 0 || down?.button !== 0 || down.dragged || moved(event)) return;
    const selected = getSelection();
    if (!selected) return;
    const hit = pick(event);
    if (!sameContourSurface(hit, selected)) return;
    const next = graphContourSelection(hit, selected.direction);
    if (next) { stop(event); onSelection(next); }
  }
  const outside = event => { if (menu && !menuElement()?.contains(event.target)) close(); };
  const escape = event => { if (menu && event.key === "Escape") { stop(event); close(); element.focus({ preventScroll: true }); } };
  const cancel = () => { down = null; close(); };
  const listeners = { pointerdown, pointermove, contextmenu, click, pointercancel: cancel };
  const capture = { capture: true };
  for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener, capture);
  document.addEventListener("pointerdown", outside, capture);
  document.addEventListener("keydown", escape, capture);
  document.defaultView?.addEventListener("blur", cancel);
  return {
    close,
    preview(direction) { if (menu && !blocked()) onPreview(graphContourSelection(menu.hit, direction)); },
    clearPreview() { onPreview(null); },
    choose(direction) {
      if (!menu || blocked()) return;
      const next = graphContourSelection(menu.hit, direction);
      if (next) onSelection(next);
      close(); element.focus({ preventScroll: true });
    },
    dispose() {
      for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener, capture);
      document.removeEventListener("pointerdown", outside, capture); document.removeEventListener("keydown", escape, capture);
      document.defaultView?.removeEventListener("blur", cancel); close();
    },
  };
}
