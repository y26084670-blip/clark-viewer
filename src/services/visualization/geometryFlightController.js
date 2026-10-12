const FLIGHT_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "ControlRight",
  "KeyQ", "KeyE", "ShiftRight", "Equal", "Minus", "NumpadAdd", "NumpadSubtract",
]);
const MIN_ZOOM = 0.02, MAX_ZOOM = 100, ZOOM_RATE = 1.2, ZOOM_TAP = Math.log(1.08);
export const GEOMETRY_FLIGHT_HELP = "↑/↓ — вперёд/назад; ←/→ — влево/вправо; мышь — направление; Enter — подъём; правый Ctrl — опускание; +/− — масштаб; Q/E — крен; правый Shift — ускорение ×4; Esc — выход";
const zoomKey = code => code === "Equal" || code === "NumpadAdd" ? 1
  : code === "Minus" || code === "NumpadSubtract" ? -1 : 0;

/** Camera-local thrust with world-space inertia. No scene or result buffers. */
export function createGeometryFlightMotion(THREE, {
  camera, target, speed = 1, sensitivity = 0.0025,
}) {
  const keys = new Set();
  const velocity = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const difference = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const baseSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const distance = Math.max(camera.position.distanceTo(target), baseSpeed * 0.01, 1e-8);
  const epsilon = baseSpeed * 1e-5;
  let mouseX = 0, mouseY = 0, zoomImpulse = 0;
  const pressed = code => keys.has(code) ? 1 : 0;
  const zoomDirection = () => Number(keys.has("Equal") || keys.has("NumpadAdd"))
    - Number(keys.has("Minus") || keys.has("NumpadSubtract"));
  const canZoom = () => (zoomDirection() > 0 && camera.zoom < MAX_ZOOM)
    || (zoomDirection() < 0 && camera.zoom > MIN_ZOOM);
  const syncTarget = () => {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.up.copy(up);
    target.copy(camera.position).addScaledVector(forward, distance);
  };
  return {
    key(code, down) {
      if (!FLIGHT_KEYS.has(code)) return false;
      if (down) {
        if (!keys.has(code)) zoomImpulse += zoomKey(code) * ZOOM_TAP;
        keys.add(code);
      } else keys.delete(code);
      return true;
    },
    look(x, y) {
      if (Number.isFinite(x)) mouseX += x;
      if (Number.isFinite(y)) mouseY += y;
    },
    releaseKeys() { keys.clear(); zoomImpulse = 0; },
    clear() { keys.clear(); velocity.set(0, 0, 0); mouseX = mouseY = zoomImpulse = 0; },
    get needsFrame() {
      return mouseX !== 0 || mouseY !== 0 || velocity.lengthSq() > epsilon * epsilon
        || pressed("ArrowRight") !== pressed("ArrowLeft")
        || pressed("Enter") !== pressed("ControlRight")
        || pressed("ArrowDown") !== pressed("ArrowUp")
        || pressed("KeyQ") !== pressed("KeyE") || zoomImpulse !== 0 || canZoom();
    },
    step(seconds) {
      // A suspended/overloaded tab must not produce a large displacement.
      const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(0.1, seconds)) : 0;
      const roll = pressed("KeyQ") - pressed("KeyE");
      const turning = mouseX !== 0 || mouseY !== 0 || (roll !== 0 && dt > 0);
      if (turning) {
        camera.rotateY(-mouseX * sensitivity);
        camera.rotateX(-mouseY * sensitivity);
        camera.rotateZ(roll * 1.5 * dt);
        camera.quaternion.normalize();
      }
      mouseX = mouseY = 0;
      const zoomDelta = zoomImpulse + zoomDirection() * ZOOM_RATE * dt;
      zoomImpulse = 0;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * Math.exp(zoomDelta)));
      const zooming = nextZoom !== camera.zoom;
      if (zooming) { camera.zoom = nextZoom; camera.updateProjectionMatrix(); }
      desired.set(pressed("ArrowRight") - pressed("ArrowLeft"),
        pressed("Enter") - pressed("ControlRight"),
        pressed("ArrowDown") - pressed("ArrowUp"));
      const thrust = desired.lengthSq() > 0;
      if (thrust) desired.normalize().applyQuaternion(camera.quaternion)
        .multiplyScalar(baseSpeed * (keys.has("ShiftRight") ? 4 : 1));
      const moving = velocity.lengthSq() > epsilon * epsilon || thrust;
      if (moving && dt > 0) {
        const tau = thrust ? 0.25 : 0.4;
        const decay = Math.exp(-dt / tau);
        difference.copy(velocity).sub(desired);
        camera.position.addScaledVector(desired, dt)
          .addScaledVector(difference, tau * (1 - decay));
        velocity.copy(desired).addScaledVector(difference, decay);
        if (!thrust && velocity.lengthSq() < epsilon * epsilon) velocity.set(0, 0, 0);
      }
      syncTarget();
      return turning || zooming || (moving && dt > 0);
    },
  };
}

/** Pointer lock owns the lifetime; RAF remains owned by the existing viewport. */
export function createGeometryFlightController({
  THREE, element, getCamera, getTarget, getSpeed = () => 1, canStart = () => true,
  onActivate = () => {}, onDeactivate = () => {}, onStateChange = () => {},
  onError = () => {}, requestRender = () => {},
}) {
  const owner = element.ownerDocument;
  const win = owner.defaultView;
  let state = "idle", motion = null, lastTime = null, disposed = false, generation = 0;
  let rightControl = false, leftControl = false;
  const setState = value => { state = value; onStateChange(value); };
  const locked = () => owner.pointerLockElement === element;
  const controller = {
    get state() { return state; },
    get active() { return state === "active"; },
    get needsFrame() { return state === "active" && motion?.needsFrame; },
    start() {
      if (disposed || state !== "idle") return;
      if (!canStart() || owner.hidden || owner.pointerLockElement) {
        onError("Дождитесь готовности выбранного кадра и вернитесь в окно 3D.");
        return;
      }
      if (typeof element.requestPointerLock !== "function") {
        onError("Браузер не поддерживает захват мыши для полёта.");
        return;
      }
      const attempt = ++generation;
      setState("starting");
      try {
        // Directly within the button's user gesture; support both API forms.
        element.requestPointerLock()?.catch?.(() => {
          if (attempt === generation && state === "starting") failLock();
        });
      } catch { failLock(); }
    },
    stop() {
      const wasActive = state === "active";
      generation++;
      rightControl = leftControl = false;
      motion?.clear(); motion = null; lastTime = null;
      if (state !== "idle") setState("idle");
      if (locked()) owner.exitPointerLock();
      if (wasActive) onDeactivate();
      requestRender();
    },
    update(timestamp) {
      if (state !== "active") return;
      const dt = lastTime === null ? 0 : (timestamp - lastTime) / 1000;
      lastTime = timestamp;
      motion.step(dt);
      if (!motion.needsFrame) lastTime = null;
    },
    dispose() {
      disposed = true;
      controller.stop();
      owner.removeEventListener("pointerlockchange", lockChange);
      owner.removeEventListener("pointerlockerror", lockError);
      owner.removeEventListener("mousemove", mouseMove);
      owner.removeEventListener("keydown", keyDown, true);
      owner.removeEventListener("keyup", keyUp, true);
      owner.removeEventListener("visibilitychange", visibilityChange);
      win?.removeEventListener("blur", blur);
    },
  };
  function failLock() {
    controller.stop();
    if (!disposed) onError("Не удалось захватить мышь. Повторите включение полёта кнопкой «Полёт».");
  }
  function lockChange() {
    if (!locked()) {
      if (state !== "idle") controller.stop();
      return;
    }
    if (disposed || state !== "starting" || !canStart() || owner.hidden) {
      controller.stop(); return;
    }
    try {
      onActivate();
      motion = createGeometryFlightMotion(THREE, {
        camera: getCamera(), target: getTarget(), speed: getSpeed(),
      });
      motion.step(0);
      lastTime = null;
      setState("active");
      requestRender();
    } catch { failLock(); }
  }
  function lockError() { if (state === "starting") failLock(); }
  function mouseMove(event) {
    if (state !== "active" || !locked()) return;
    motion.look(event.movementX, event.movementY);
    requestRender();
  }
  function keyDown(event) {
    if (state !== "active" || event.isComposing) return;
    if (event.code === "Escape") { event.preventDefault(); event.stopPropagation(); controller.stop(); return; }
    if (event.code === "ControlRight") rightControl = true;
    if (event.code === "ControlLeft") leftControl = true;
    // Right Ctrl is thrust, including when held together with arrows or zoom.
    if (leftControl || (event.ctrlKey && !rightControl) || event.altKey || event.metaKey) {
      motion.releaseKeys(); return;
    }
    if (motion.key(event.code, true)) { event.preventDefault(); event.stopPropagation(); requestRender(); }
  }
  function keyUp(event) {
    if (event.code === "ControlRight") rightControl = false;
    if (event.code === "ControlLeft") leftControl = false;
    if (state === "active" && motion.key(event.code, false)) {
      event.preventDefault(); event.stopPropagation(); requestRender();
    }
    if (state === "active" && event.code === "ControlLeft" && rightControl && !event.altKey && !event.metaKey) {
      motion.key("ControlRight", true); requestRender();
    }
  }
  function blur() { if (state !== "idle") controller.stop(); }
  function visibilityChange() { if (owner.hidden) blur(); }
  owner.addEventListener("pointerlockchange", lockChange);
  owner.addEventListener("pointerlockerror", lockError);
  owner.addEventListener("mousemove", mouseMove);
  owner.addEventListener("keydown", keyDown, true);
  owner.addEventListener("keyup", keyUp, true);
  owner.addEventListener("visibilitychange", visibilityChange);
  win?.addEventListener("blur", blur);
  return controller;
}
