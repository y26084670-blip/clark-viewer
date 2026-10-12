const FLIGHT_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "ControlRight",
  "KeyQ", "KeyE", "ShiftRight", "Equal", "Minus", "NumpadAdd", "NumpadSubtract",
]);
const ORBIT_KEYS = new Set(["ArrowLeft", "ArrowRight", "Enter", "ControlRight"]);
const MIN_ZOOM = 0.02, MAX_ZOOM = 100, ZOOM_RATE = 1.2, ZOOM_TAP = Math.log(1.08);
const LOOK_TAU = 0.25, LOOK_EPSILON = 0.001, APPROACH_SECONDS = 0.5;
const ORBIT_RATE = Math.PI / 6, ORBIT_EPSILON = 1e-5;
export const GEOMETRY_FLIGHT_HELP = "Перспективный полёт; ↑/↓ — вперёд/назад; ←/→ — вращение вокруг цели по горизонтали; Enter/правый Ctrl — вращение по вертикали; центр — ближайшая поверхность под прицелом; без поверхности вращения нет; скорость 30°/с; мышь — направление и отмена вращения; +/− — масштаб; Q/E — крен; правый Shift — ускорение ×4; ЛКМ — подлёт к цели в прицеле; новый ручной ввод — отмена подлёта; Esc — прежний вид и выход";
const zoomKey = code => code === "Equal" || code === "NumpadAdd" ? 1
  : code === "Minus" || code === "NumpadSubtract" ? -1 : 0;

/** Free flight keeps world-space inertia; orbit rotates about a retained surface point. */
export function createGeometryFlightMotion(THREE, {
  camera, target, speed = 1, sensitivity = 0.000625, getOrbitTarget = () => null,
}) {
  const keys = new Set(), blockedOrbitKeys = new Set();
  const velocity = new THREE.Vector3(), desired = new THREE.Vector3(), difference = new THREE.Vector3();
  const forward = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3(), axis = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const angularVelocity = new THREE.Vector2(), angularDesired = new THREE.Vector2(), angles = new THREE.Vector2();
  const baseSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const distance = Math.max(camera.position.distanceTo(target), baseSpeed * 0.01, 1e-8);
  const epsilon = baseSpeed * 1e-5;
  let mouseX = 0, mouseY = 0, zoomImpulse = 0, approach = null, orbit = null;
  const cancelApproach = () => { if (approach) { approach = null; velocity.set(0, 0, 0); } };
  const cancelOrbit = (blockHeld = false) => {
    for (const code of ORBIT_KEYS) {
      if (blockHeld && keys.has(code)) blockedOrbitKeys.add(code);
      keys.delete(code);
    }
    orbit = null; angularVelocity.set(0, 0);
  };
  const clear = () => {
    keys.clear(); blockedOrbitKeys.clear(); velocity.set(0, 0, 0); angularVelocity.set(0, 0);
    mouseX = mouseY = zoomImpulse = 0; approach = orbit = null;
  };
  const beginOrbit = () => {
    const selected = getOrbitTarget();
    if (!Array.isArray(selected?.point) || selected.point.length !== 3 || !selected.point.every(Number.isFinite)) return false;
    const point = new THREE.Vector3().fromArray(selected.point);
    if (!(camera.position.distanceTo(point) > epsilon)) return false;
    orbit = { point, target: { ...selected, point: [...selected.point] } };
    // A new orbit gesture supersedes free-flight drift and the remaining mouse turn.
    velocity.set(0, 0, 0); mouseX = mouseY = 0;
    camera.lookAt(point); camera.quaternion.normalize();
    return true;
  };
  const pressed = code => keys.has(code) ? 1 : 0;
  const orbitInput = () => orbit && (pressed("ArrowRight") !== pressed("ArrowLeft") || pressed("Enter") !== pressed("ControlRight"));
  const zoomDirection = () => Number(keys.has("Equal") || keys.has("NumpadAdd")) - Number(keys.has("Minus") || keys.has("NumpadSubtract"));
  const canZoom = () => (zoomDirection() > 0 && camera.zoom < MAX_ZOOM) || (zoomDirection() < 0 && camera.zoom > MIN_ZOOM);
  const syncTarget = () => {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion); camera.up.copy(up);
    if (orbit) target.copy(orbit.point);
    else target.copy(camera.position).addScaledVector(forward, distance);
  };
  return {
    key(code, down) {
      if (!FLIGHT_KEYS.has(code)) return false;
      if (down) {
        cancelApproach();
        if (ORBIT_KEYS.has(code)) {
          if (blockedOrbitKeys.has(code)) return true;
          if (!orbit && !beginOrbit()) { blockedOrbitKeys.add(code); return true; }
        }
        if (!keys.has(code)) zoomImpulse += zoomKey(code) * ZOOM_TAP;
        keys.add(code);
      } else {
        keys.delete(code); blockedOrbitKeys.delete(code);
        if (orbit && angularVelocity.lengthSq() === 0 && !Array.from(ORBIT_KEYS).some(key => keys.has(key))) cancelOrbit();
      }
      return true;
    },
    look(x, y) {
      if ((Number.isFinite(x) && x !== 0) || (Number.isFinite(y) && y !== 0)) { cancelApproach(); cancelOrbit(true); }
      if (Number.isFinite(x)) mouseX += x;
      if (Number.isFinite(y)) mouseY += y;
    },
    approach(point, stopDistance) {
      if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
          || !Number.isFinite(stopDistance) || !(stopDistance > 0)) return false;
      const destination = new THREE.Vector3().fromArray(point), length = camera.position.distanceTo(destination);
      if (!(length > epsilon)) return false;
      clear(); if (length <= stopDistance) return true;
      const start = camera.position.clone(), end = start.clone().lerp(destination, 1 - stopDistance / length);
      camera.lookAt(destination); camera.quaternion.normalize(); approach = { start, end, elapsed: 0 }; syncTarget();
      return true;
    },
    get orbitTarget() { return orbit?.target ?? null; },
    get orbiting() { return orbit !== null; },
    get approaching() { return approach !== null; },
    releaseKeys() { cancelApproach(); cancelOrbit(); keys.clear(); blockedOrbitKeys.clear(); zoomImpulse = 0; },
    clear,
    get needsFrame() {
      return approach !== null || mouseX !== 0 || mouseY !== 0 || velocity.lengthSq() > epsilon * epsilon
        || angularVelocity.lengthSq() > ORBIT_EPSILON * ORBIT_EPSILON || Boolean(orbitInput())
        || pressed("ArrowDown") !== pressed("ArrowUp") || pressed("KeyQ") !== pressed("KeyE") || zoomImpulse !== 0 || canZoom();
    },
    step(seconds) {
      const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(0.1, seconds)) : 0;
      if (approach) {
        approach.elapsed += dt;
        const fraction = approach.elapsed >= APPROACH_SECONDS - 1e-12 ? 1 : approach.elapsed / APPROACH_SECONDS;
        camera.position.lerpVectors(approach.start, approach.end, fraction * fraction * (3 - 2 * fraction));
        if (fraction === 1) approach = null;
        syncTarget(); return dt > 0;
      }
      const roll = pressed("KeyQ") - pressed("KeyE"), decay = Math.exp(-dt / LOOK_TAU);
      const yaw = dt > 0 ? mouseX * (Math.abs(mouseX * decay) < LOOK_EPSILON ? 1 : 1 - decay) : 0;
      const pitch = dt > 0 ? mouseY * (Math.abs(mouseY * decay) < LOOK_EPSILON ? 1 : 1 - decay) : 0;
      mouseX -= yaw; mouseY -= pitch;
      const turning = yaw !== 0 || pitch !== 0 || (roll !== 0 && dt > 0);
      if (turning) {
        camera.rotateY(-yaw * sensitivity); camera.rotateX(-pitch * sensitivity); camera.rotateZ(roll * 1.5 * dt); camera.quaternion.normalize();
      }
      let orbitMoved = false;
      if (orbit && dt > 0) {
        angularDesired.set(pressed("ArrowRight") - pressed("ArrowLeft"), pressed("Enter") - pressed("ControlRight"));
        const thrust = angularDesired.lengthSq() > 0, tau = thrust ? 0.25 : 0.4, decay = Math.exp(-dt / tau);
        if (thrust) angularDesired.normalize().multiplyScalar(ORBIT_RATE * (keys.has("ShiftRight") ? 4 : 1));
        angles.copy(angularVelocity).sub(angularDesired).multiplyScalar(tau * (1 - decay)).addScaledVector(angularDesired, dt);
        angularVelocity.sub(angularDesired).multiplyScalar(decay).add(angularDesired);
        if (!thrust && angularVelocity.lengthSq() < ORBIT_EPSILON * ORBIT_EPSILON) {
          angles.addScaledVector(angularVelocity, tau); angularVelocity.set(0, 0);
        }
        right.set(1, 0, 0).applyQuaternion(camera.quaternion); up.set(0, 1, 0).applyQuaternion(camera.quaternion);
        axis.copy(up).multiplyScalar(angles.x).addScaledVector(right, -angles.y);
        const angle = axis.length();
        if (angle > 0) {
          rotation.setFromAxisAngle(axis.divideScalar(angle), angle);
          camera.position.sub(orbit.point).applyQuaternion(rotation).add(orbit.point);
          camera.quaternion.premultiply(rotation).normalize(); velocity.applyQuaternion(rotation); orbitMoved = true;
        }
        if (!thrust && angularVelocity.lengthSq() === 0 && !Array.from(ORBIT_KEYS).some(code => keys.has(code))) cancelOrbit();
      }
      const zoomDelta = zoomImpulse + zoomDirection() * ZOOM_RATE * dt; zoomImpulse = 0;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * Math.exp(zoomDelta))), zooming = nextZoom !== camera.zoom;
      if (zooming) { camera.zoom = nextZoom; camera.updateProjectionMatrix(); }
      desired.set(0, 0, pressed("ArrowDown") - pressed("ArrowUp"));
      const thrust = desired.lengthSq() > 0;
      if (thrust) desired.applyQuaternion(camera.quaternion).multiplyScalar(baseSpeed * (keys.has("ShiftRight") ? 4 : 1));
      const moving = velocity.lengthSq() > epsilon * epsilon || thrust;
      if (moving && dt > 0) {
        const tau = thrust ? 0.25 : 0.4, decay = Math.exp(-dt / tau);
        difference.copy(velocity).sub(desired);
        camera.position.addScaledVector(desired, dt).addScaledVector(difference, tau * (1 - decay));
        velocity.copy(desired).addScaledVector(difference, decay);
        if (!thrust && velocity.lengthSq() < epsilon * epsilon) velocity.set(0, 0, 0);
        forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
        if (orbit && orbit.point.clone().sub(camera.position).dot(forward) <= epsilon) cancelOrbit(true);
      }
      syncTarget(); return turning || orbitMoved || zooming || (moving && dt > 0);
    },
  };
}

/** Pointer lock owns the lifetime; RAF remains owned by the existing viewport. */
export function createGeometryFlightController({
  THREE, element, getCamera, getTarget, getSpeed = () => 1, canStart = () => true,
  getApproachTarget = () => null, getOrbitTarget = () => null,
  onActivate = () => {}, onDeactivate = () => {}, onStateChange = () => {},
  onError = () => {}, requestRender = () => {},
}) {
  const owner = element.ownerDocument;
  const win = owner.defaultView;
  let state = "idle", motion = null, lastTime = null, disposed = false, generation = 0;
  let rightControl = false, leftControl = false;
  const heldKeys = new Set(), suppressedKeys = new Set();
  const setState = value => { state = value; onStateChange(value); };
  const locked = () => owner.pointerLockElement === element;
  const controller = {
    get state() { return state; },
    get active() { return state === "active"; },
    get orbitTarget() { return state === "active" ? motion?.orbitTarget : null; },
    get orbiting() { return state === "active" && motion?.orbiting; },
    get approaching() { return state === "active" && motion?.approaching; },
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
    stop(reason = "stop") {
      const wasActive = state === "active";
      generation++;
      rightControl = leftControl = false;
      heldKeys.clear(); suppressedKeys.clear();
      motion?.clear(); motion = null; lastTime = null;
      if (state !== "idle") setState("idle");
      if (locked()) owner.exitPointerLock();
      if (wasActive) onDeactivate(reason);
      requestRender();
    },
    update(timestamp) {
      if (state !== "active") return;
      const dt = lastTime === null ? 0 : (timestamp - lastTime) / 1000;
      lastTime = timestamp;
      motion.step(dt);
      if (!motion.needsFrame) lastTime = null;
    },
    approach(point, stopDistance) {
      if (state !== "active" || !motion.approach(point, stopDistance)) return false;
      for (const code of heldKeys) suppressedKeys.add(code);
      lastTime = null; requestRender(); return true;
    },
    dispose() {
      disposed = true;
      controller.stop();
      owner.removeEventListener("pointerlockchange", lockChange);
      owner.removeEventListener("pointerlockerror", lockError);
      owner.removeEventListener("mousemove", mouseMove);
      owner.removeEventListener("click", click, true);
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
      if (state !== "idle") controller.stop("unlock");
      return;
    }
    if (disposed || state !== "starting" || !canStart() || owner.hidden) {
      controller.stop(); return;
    }
    try {
      onActivate();
      motion = createGeometryFlightMotion(THREE, {
        camera: getCamera(), target: getTarget(), speed: getSpeed(), getOrbitTarget,
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
  function click(event) {
    if (state !== "active" || !locked() || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const destination = getApproachTarget();
    if (destination) controller.approach(destination.point, destination.stopDistance);
  }
  function keyDown(event) {
    if (state !== "active" || event.isComposing) return;
    if (event.code === "Escape") { event.preventDefault(); event.stopPropagation(); controller.stop("escape"); return; }
    if (event.code === "ControlRight") rightControl = true;
    if (event.code === "ControlLeft") leftControl = true;
    if (FLIGHT_KEYS.has(event.code)) heldKeys.add(event.code);
    if (suppressedKeys.has(event.code)) { event.preventDefault(); event.stopPropagation(); return; }
    // Right Ctrl is vertical orbit, including combinations with arrows or zoom.
    if (leftControl || (event.ctrlKey && !rightControl) || event.altKey || event.metaKey) {
      motion.releaseKeys(); return;
    }
    if (motion.key(event.code, true)) { event.preventDefault(); event.stopPropagation(); requestRender(); }
  }
  function keyUp(event) {
    heldKeys.delete(event.code); suppressedKeys.delete(event.code);
    if (event.code === "ControlRight") rightControl = false;
    if (event.code === "ControlLeft") leftControl = false;
    if (state === "active" && motion.key(event.code, false)) {
      event.preventDefault(); event.stopPropagation(); requestRender();
    }
    if (state === "active" && event.code === "ControlLeft" && rightControl && !suppressedKeys.has("ControlRight") && !event.altKey && !event.metaKey) {
      motion.key("ControlRight", true); requestRender();
    }
  }
  function blur() { if (state !== "idle") controller.stop("blur"); }
  function visibilityChange() { if (owner.hidden) blur(); }
  owner.addEventListener("pointerlockchange", lockChange);
  owner.addEventListener("pointerlockerror", lockError);
  owner.addEventListener("mousemove", mouseMove);
  owner.addEventListener("click", click, true);
  owner.addEventListener("keydown", keyDown, true);
  owner.addEventListener("keyup", keyUp, true);
  owner.addEventListener("visibilitychange", visibilityChange);
  win?.addEventListener("blur", blur);
  return controller;
}
