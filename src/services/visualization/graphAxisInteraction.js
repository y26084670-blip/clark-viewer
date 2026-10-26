import { pointHitMetadata } from "./geometryPicking.js";
import { sameGraphObject, graphPlaneFrame } from "./graphAxes.js";

export function installGraphAxisInteraction({ THREE, element, controller, getCamera, getControls,
  getAxes, getPoints, getNodePosition, getPlanes, blocked, onPreview, onChange }) {
  const scratch = new THREE.Vector3(), raycaster = new THREE.Raycaster();
  let gesture = null, previousCursor = element.style.cursor, handledAt = -Infinity;
  const screen = (point, box) => {
    scratch.fromArray(point).project(getCamera());
    return { x: box.left + (scratch.x + 1) * box.width / 2, y: box.top + (1 - scratch.y) * box.height / 2, z: scratch.z };
  };
  function pickNode(event, lock) {
    const box = element.getBoundingClientRect(), camera = getCamera(), { positions, ranges } = getPoints();
    let best, distance = 12 ** 2, depth = Infinity;
    for (const range of ranges) for (let image = 0; image < range.instances.length; image++) {
      if (lock && !sameGraphObject(lock, { source: range.source, instance: range.instances[image] })) continue;
      const first = range.start + image * range.sourcePointCount;
      for (let index = first; index < first + range.sourcePointCount; index++) {
        scratch.fromArray(positions, index * 3).project(camera);
        if (scratch.z < -1 || scratch.z > 1) continue;
        const x = box.left + (scratch.x + 1) * box.width / 2, y = box.top + (1 - scratch.y) * box.height / 2;
        const d = (x - event.clientX) ** 2 + (y - event.clientY) ** 2;
        if (d < distance - 1e-4 || (Math.abs(d - distance) < 1e-4 && scratch.z < depth)) { best = { range, index }; distance = d; depth = scratch.z; }
      }
    }
    if (!best) return null;
    const metadata = pointHitMetadata(best.range, best.index);
    return metadata ? { source: best.range.source, instance: metadata.instance, pointIndex: metadata.pointIndex,
      position: Array.from(positions.slice(best.index * 3, best.index * 3 + 3)) } : null;
  }
  function pickEnd(event) {
    const box = element.getBoundingClientRect(); let best, distance = 14 ** 2;
    for (const axis of getAxes()) for (const [end, point] of [axis.start, axis.end].entries()) {
      const p = screen(point, box), d = (event.clientX - p.x) ** 2 + (event.clientY - p.y) ** 2;
      if (p.z >= -1 && p.z <= 1 && d < distance) { best = { id: axis.id, end }; distance = d; }
    }
    return best;
  }
  function selectAxis(event) {
    const endpoint = pickEnd(event); if (endpoint) return endpoint.id;
    const box = element.getBoundingClientRect(); let best, distance = 7 ** 2;
    for (const axis of getAxes()) {
      const a = screen(axis.start, box), b = screen(axis.end, box), dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((event.clientX - a.x) * dx + (event.clientY - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = (event.clientX - a.x - t * dx) ** 2 + (event.clientY - a.y - t * dy) ** 2;
      if (a.z >= -1 && a.z <= 1 && b.z >= -1 && b.z <= 1 && d < distance) { best = axis.id; distance = d; }
    }
    if (best != null) return best;
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2), getCamera());
    return raycaster.intersectObjects(getPlanes().filter(p => p.visible), false)[0]?.object.userData.axisId;
  }
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  function finish() {
    const previous = gesture; gesture = null;
    if (previous?.captured) {
      if (element.hasPointerCapture?.(previous.pointerId)) element.releasePointerCapture(previous.pointerId);
      getControls().enabled = previous.controlsEnabled;
    }
    controller.release();
  }
  function down(event) {
    if (event.button !== 0 || blocked()) return;
    const mode = controller.state.mode, hit = mode !== "add" ? pickEnd(event) : null;
    gesture = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, mode, hit };
    if (!mode) return;
    consume(event);
    gesture.controlsEnabled = getControls().enabled; getControls().enabled = false;
    gesture.captured = true; element.setPointerCapture?.(event.pointerId);
    if (mode === "edit" && hit) controller.grab(hit.id, hit.end);
  }
  function move(event) {
    if (blocked()) return;
    if (controller.state.drag) { consume(event); controller.move(pickNode(event, controller.state.drag.before)); return; }
    if (!controller.state.pending) return;
    let start;
    try { start = getNodePosition(controller.state.pending); } catch { return; }
    const box = element.getBoundingClientRect(), z = scratch.fromArray(start).project(getCamera()).z;
    const end = new THREE.Vector3((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2, z).unproject(getCamera()).toArray();
    onPreview(start, end);
  }
  function up(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const previous = gesture, click = Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 5;
    finish(); if (blocked()) return;
    if (previous.mode) { handledAt = event.timeStamp; consume(event); }
    if (!click) return;
    if (previous.mode === "add") {
      const point = pickNode(event);
      let up = getCamera().up.toArray();
      if (point && controller.state.pending) {
        const start = getNodePosition(controller.state.pending);
        const view = getCamera().getWorldDirection(new THREE.Vector3()).negate();
        const right = new THREE.Vector3(...point.position).sub(new THREE.Vector3(...start));
        if (right.lengthSq() > 0) up = graphPlaneFrame(start, point.position, view.cross(right).toArray()).up;
      }
      controller.point(point, up); onPreview(null);
    } else if (previous.mode === "delete" && previous.hit) controller.grab(previous.hit.id, previous.hit.end);
    else if (!previous.mode) { const id = selectAxis(event); if (id != null) {
      handledAt = event.timeStamp; consume(event); controller.select(id); onChange?.();
    } }
  }
  const suppressClick = event => { if (controller.state.mode || event.timeStamp - handledAt < 500) consume(event); };
  const escape = event => {
    if (event.key !== "Escape" || !controller.state.mode || event.target?.closest?.("dialog[open]")) return;
    consume(event); controller.cancel(); finish(); onPreview(null);
  };
  const cancel = () => { finish(); onPreview(null); };
  const listeners = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, click: suppressClick, dblclick: suppressClick };
  for (const [name, callback] of Object.entries(listeners)) element.addEventListener(name, callback, true);
  window.addEventListener("keydown", escape, true);
  return {
    sync() {
      if (!controller.state.mode || blocked()) { finish(); onPreview(null); }
      element.style.cursor = controller.state.mode === "add" ? "crosshair" : controller.state.mode === "edit" ? "move" : controller.state.mode === "delete" ? "pointer" : previousCursor;
      if (!controller.state.pending) onPreview(null);
    },
    dispose() { finish(); onPreview(null); element.style.cursor = previousCursor;
      for (const [name, callback] of Object.entries(listeners)) element.removeEventListener(name, callback, true);
      window.removeEventListener("keydown", escape, true); },
  };
}
