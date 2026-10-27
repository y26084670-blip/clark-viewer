const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function limits(size, panelSize) {
  const space = Math.max(0, size - panelSize);
  const minimum = Math.min(8, space / 2);
  return { minimum, span: Math.max(0, space - 2 * minimum) };
}

/** Relative positions survive resizing without letting a panel leave its viewport. */
export function geometryOverlayPosition({ width, height, panelWidth, panelHeight }, position) {
  const x = limits(width, panelWidth), y = limits(height, panelHeight);
  return { left: x.minimum + x.span * clamp(position.x), top: y.minimum + y.span * clamp(position.y) };
}

/** Drag only a panel's heading; retain small relative coordinates, never scene data. */
export function installGeometryOverlayDrag(element, { getPosition, setPosition }) {
  let gesture = null, observer = null, pointerOwner = null, disposed = false;
  const measure = () => {
    const parent = element.parentElement;
    if (!parent || !parent.clientWidth || !parent.clientHeight) return null;
    const rect = parent.getBoundingClientRect();
    return { width: parent.clientWidth, height: parent.clientHeight,
      panelWidth: element.offsetWidth, panelHeight: element.offsetHeight,
      left: rect.left + parent.clientLeft, top: rect.top + parent.clientTop };
  };
  const apply = (position, bounds) => {
    const { left, top } = geometryOverlayPosition(bounds, position);
    element.style.left = `${left}px`; element.style.top = `${top}px`; element.style.right = "auto"; element.style.bottom = "auto";
  };
  const refresh = () => {
    if (disposed) return;
    const bounds = measure(), position = gesture?.position ?? getPosition();
    if (bounds && position) apply(position, bounds);
  };
  const removeGestureListeners = () => {
    pointerOwner?.removeEventListener("pointermove", move, true);
    pointerOwner?.removeEventListener("pointerup", finish, true);
    pointerOwner?.removeEventListener("pointercancel", finish, true);
  };
  const connect = () => {
    const owner = element.ownerDocument;
    const current = owner.defaultView ?? owner;
    if (pointerOwner === current) return;
    removeGestureListeners(); pointerOwner = current;
    pointerOwner.addEventListener("pointermove", move, true);
    pointerOwner.addEventListener("pointerup", finish, true);
    pointerOwner.addEventListener("pointercancel", finish, true);
  };
  function down(event) {
    const handle = event.target.closest?.(".geometry-overlay-drag-handle");
    if (disposed || gesture || event.button !== 0 || !handle || !element.contains(handle)) return;
    connect();
    const bounds = measure(); if (!bounds) return;
    const rect = element.getBoundingClientRect();
    gesture = { id: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      position: null };
    event.preventDefault(); event.stopPropagation(); element.classList.add("is-dragging");
    try { element.setPointerCapture?.(event.pointerId); } catch { /* Window listeners also cover capture refusal. */ }
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const bounds = measure(); if (!bounds) return;
    const x = limits(bounds.width, bounds.panelWidth), y = limits(bounds.height, bounds.panelHeight);
    gesture.position = {
      x: x.span ? clamp((event.clientX - bounds.left - gesture.offsetX - x.minimum) / x.span) : 0,
      y: y.span ? clamp((event.clientY - bounds.top - gesture.offsetY - y.minimum) / y.span) : 0,
    };
    apply(gesture.position, bounds); event.preventDefault(); event.stopPropagation();
  }
  function finish(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const previous = gesture; gesture = null; element.classList.remove("is-dragging");
    if (previous.position) setPosition(previous.position);
    try { element.releasePointerCapture?.(previous.id); } catch { /* Already released by the browser. */ }
    event.stopPropagation();
  }
  element.addEventListener("pointerdown", down);
  element.addEventListener("lostpointercapture", finish);
  queueMicrotask(() => {
    if (disposed) return;
    // Solid refs can initially belong to an inert template document. Read the
    // live document after insertion, rather than retaining that detached owner.
    connect();
    const owner = element.ownerDocument;
    const ResizeObserver = owner.defaultView?.ResizeObserver;
    if (ResizeObserver && element.parentElement) {
      observer = new ResizeObserver(refresh); observer.observe(element.parentElement); observer.observe(element);
    }
    refresh();
  });
  return { refresh, dispose() {
    disposed = true; observer?.disconnect(); removeGestureListeners();
    element.removeEventListener("pointerdown", down); element.removeEventListener("lostpointercapture", finish);
    if (gesture) {
      const id = gesture.id; gesture = null;
      try { element.releasePointerCapture?.(id); } catch { /* Detached element. */ }
    }
    element.classList.remove("is-dragging");
  } };
}
