const FLIGHT_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ControlRight",
  "Enter", "NumpadEnter", "ShiftRight", "Equal", "Minus", "NumpadAdd", "NumpadSubtract",
  "Digit0", "Numpad0",
]);
const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const MIN_SPEED = 1 / 64, MAX_SPEED = 64, SPEED_RATE = Math.log(2), SPEED_TAP = 1.25;
const LOOK_TAU = 0.25, LOOK_EPSILON = 0.001, APPROACH_SECONDS = 0.5;
const ORBIT_RATE = Math.PI / 6, ORBIT_EPSILON = 1e-5;
const ORBIT_PICK_SECONDS = 0.08;
export const GEOMETRY_FLIGHT_HELP = "Перспективный полёт; ←/→ — линейное перемещение вида влево/вправо; ↑/↓ — приближение/удаление вида; Enter — линейное перемещение вида вверх; правый Ctrl — линейное перемещение вида вниз; правый Shift+←/→ — вращение влево/вправо вокруг центра; правый Shift+↑/↓ — вращение вверх/вниз вокруг центра; направления относительно экрана, объекты перемещаются противоположно взгляду; центр — ближайшая поверхность под прицелом; при промахе — последний найденный центр; до первого попадания вращения нет; скорость вращения 30°/с; мышь — направление и уточнение центра без отмены вращения; +/− — линейная скорость: шаг ×1,25 / ÷1,25, удержание — плавная регулировка, диапазон ×1/64…×64; 0 — штатная скорость ×1; Enter+←/→ — крен против/по часовой стрелке; ЛКМ — подлёт к цели в прицеле; новый ручной ввод — отмена подлёта; A — начальный вид полёта без выхода; Esc — прежний вид и выход";
const speedKey = code => code === "Equal" || code === "NumpadAdd" ? 1
  : code === "Minus" || code === "NumpadSubtract" ? -1 : 0;
const resetSpeedKey = code => code === "Digit0" || code === "Numpad0";
const rollKey = code => code === "Enter" || code === "NumpadEnter";
const horizontalKey = code => code === "ArrowLeft" || code === "ArrowRight";
export const formatGeometryFlightSpeed = multiplier => `Скорость ×${multiplier.toLocaleString("ru-RU", { maximumFractionDigits: 3, useGrouping: false })}`;

/** Free flight keeps world-space inertia; orbit rotates about a retained surface point. */
export function createGeometryFlightMotion(THREE, {
  camera, target, speed = 1, sensitivity = 0.000625, getOrbitTarget = () => null,
}) {
  const keys = new Set(), blockedOrbitKeys = new Set();
  const velocity = new THREE.Vector3(), desired = new THREE.Vector3(), difference = new THREE.Vector3();
  const forward = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3(), axis = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const angularVelocity = new THREE.Vector2(), angularDesired = new THREE.Vector2(), angles = new THREE.Vector2();
  const movementSegment = new THREE.Line3(), closest = new THREE.Vector3();
  const baseSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const distance = Math.max(camera.position.distanceTo(target), baseSpeed * 0.01, 1e-8);
  const epsilon = baseSpeed * 1e-5;
  let mouseX = 0, mouseY = 0, speedMultiplier = 1, approach = null, orbit = null;
  let lastOrbitTarget = null, orbitPickDelay = 0;
  const cancelApproach = () => { if (approach) { approach = null; velocity.set(0, 0, 0); } };
  const cancelOrbit = (blockHeld = false) => {
    if (blockHeld && keys.has("ShiftRight")) {
      for (const code of ARROW_KEYS) if (keys.has(code)) blockedOrbitKeys.add(code);
    }
    orbit = null; angularVelocity.set(0, 0);
  };
  const clear = (forgetTarget = true) => {
    keys.clear(); blockedOrbitKeys.clear(); velocity.set(0, 0, 0); angularVelocity.set(0, 0);
    mouseX = mouseY = 0; approach = orbit = null;
    if (forgetTarget) { lastOrbitTarget = null; orbitPickDelay = 0; }
  };
  const observeOrbitTarget = () => {
    const selected = getOrbitTarget();
    if (Array.isArray(selected?.point) && selected.point.length === 3 && selected.point.every(Number.isFinite)
      && camera.position.distanceTo(closest.fromArray(selected.point)) > epsilon) {
      lastOrbitTarget = { ...selected, point: [...selected.point] };
    }
    orbitPickDelay = ORBIT_PICK_SECONDS;
    return lastOrbitTarget;
  };
  const beginOrbit = (selected = observeOrbitTarget()) => {
    if (!selected) return false;
    const point = new THREE.Vector3().fromArray(selected.point);
    if (!(camera.position.distanceTo(point) > epsilon)) return false;
    orbit = { point, target: selected };
    // Preserve the current gaze, including when the remembered centre is off-screen.
    velocity.set(0, 0, 0);
    return true;
  };
  const pressed = code => keys.has(code) ? 1 : 0;
  const enterHeld = () => keys.has("Enter") || keys.has("NumpadEnter");
  const rolling = () => enterHeld() && (keys.has("ArrowLeft") || keys.has("ArrowRight"));
  const verticalInput = () => rolling() ? 0 : Number(enterHeld()) - pressed("ControlRight");
  const rollInput = () => rolling() ? pressed("ArrowLeft") - pressed("ArrowRight") : 0;
  const horizontalPressed = code => rolling() ? 0 : pressed(code);
  const orbitPressed = code => blockedOrbitKeys.has(code) ? 0 : pressed(code);
  const horizontalOrbitPressed = code => rolling() ? 0 : orbitPressed(code);
  const hasOrbitInput = () => keys.has("ShiftRight") &&
    (horizontalOrbitPressed("ArrowRight") !== horizontalOrbitPressed("ArrowLeft") || orbitPressed("ArrowUp") !== orbitPressed("ArrowDown"));
  const orbitInput = () => orbit && hasOrbitInput();
  const hasLinearInput = () => !keys.has("ShiftRight") &&
    (horizontalPressed("ArrowRight") !== horizontalPressed("ArrowLeft") || pressed("ArrowUp") !== pressed("ArrowDown") || verticalInput() !== 0);
  const changeRollMode = previous => {
    if (previous !== rolling() && (keys.has("ArrowLeft") || keys.has("ArrowRight"))) {
      velocity.set(0, 0, 0); cancelOrbit();
    }
  };
  const resettingSpeed = () => keys.has("Digit0") || keys.has("Numpad0");
  const speedDirection = () => resettingSpeed() ? 0
    : Number(keys.has("Equal") || keys.has("NumpadAdd")) - Number(keys.has("Minus") || keys.has("NumpadSubtract"));
  const canChangeSpeed = () => (speedDirection() > 0 && speedMultiplier < MAX_SPEED)
    || (speedDirection() < 0 && speedMultiplier > MIN_SPEED);
  const clampSpeed = value => Math.max(MIN_SPEED, Math.min(MAX_SPEED, value));
  const syncTarget = () => {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion); camera.up.copy(up);
    target.copy(camera.position).addScaledVector(forward, orbit ? camera.position.distanceTo(orbit.point) : distance);
  };
  return {
    key(code, down) {
      if (!FLIGHT_KEYS.has(code)) return false;
      const previousRollMode = rolling();
      if (down) {
        const fresh = !keys.has(code);
        if (code !== "ShiftRight") cancelApproach();
        if (fresh && (code === "ShiftRight" || code === "ControlRight" || rollKey(code))) {
          // A change of keyboard mode must not carry thrust from the old axis.
          velocity.set(0, 0, 0);
        }
        keys.add(code);
        changeRollMode(previousRollMode);
        if (fresh && rolling() && horizontalKey(code)) {
          velocity.set(0, 0, 0);
          if (!keys.has("ShiftRight") || pressed("ArrowUp") === pressed("ArrowDown")) cancelOrbit();
        }
        if (resetSpeedKey(code)) speedMultiplier = 1;
        else if (fresh && !resettingSpeed()) speedMultiplier = clampSpeed(speedMultiplier * SPEED_TAP ** speedKey(code));
        if (ARROW_KEYS.has(code) && !keys.has("ShiftRight")) cancelOrbit();
        if (!orbit && hasOrbitInput()) beginOrbit();
      } else {
        keys.delete(code); blockedOrbitKeys.delete(code);
        changeRollMode(previousRollMode);
        if (code === "ShiftRight") {
          blockedOrbitKeys.clear();
          if (hasLinearInput()) cancelOrbit();
        }
        if (code === "ControlRight" && !keys.has("ShiftRight")) velocity.set(0, 0, 0);
        if (orbit && angularVelocity.lengthSq() === 0 && !hasOrbitInput()) cancelOrbit();
      }
      return true;
    },
    look(x, y) {
      if ((Number.isFinite(x) && x !== 0) || (Number.isFinite(y) && y !== 0)) { cancelApproach(); orbitPickDelay = 0; }
      if (Number.isFinite(x)) mouseX += x;
      if (Number.isFinite(y)) mouseY += y;
    },
    approach(point, stopDistance) {
      if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
          || !Number.isFinite(stopDistance) || !(stopDistance > 0)) return false;
      const destination = new THREE.Vector3().fromArray(point), length = camera.position.distanceTo(destination);
      if (!(length > epsilon)) return false;
      clear(false); if (length <= stopDistance) return true;
      const start = camera.position.clone(), end = start.clone().lerp(destination, 1 - stopDistance / length);
      camera.lookAt(destination); camera.quaternion.normalize(); approach = { start, end, elapsed: 0 }; syncTarget();
      return true;
    },
    get orbitTarget() { return orbit?.target ?? null; },
    get lastOrbitTarget() { return lastOrbitTarget; },
    get orbiting() { return orbit !== null; },
    get approaching() { return approach !== null; },
    get speedMultiplier() { return speedMultiplier; },
    get linearSpeed() { return baseSpeed * speedMultiplier; },
    releaseKeys() { cancelApproach(); cancelOrbit(); keys.clear(); blockedOrbitKeys.clear(); },
    clear,
    get needsFrame() {
      return approach !== null || mouseX !== 0 || mouseY !== 0 || velocity.lengthSq() > epsilon * epsilon
        || angularVelocity.lengthSq() > ORBIT_EPSILON * ORBIT_EPSILON || Boolean(orbitInput())
        || hasLinearInput() || rollInput() !== 0 || canChangeSpeed();
    },
    step(seconds) {
      const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(0.1, seconds)) : 0;
      const previousSpeed = speedMultiplier;
      speedMultiplier = clampSpeed(speedMultiplier * Math.exp(speedDirection() * SPEED_RATE * dt));
      if (approach) {
        approach.elapsed += dt;
        const fraction = approach.elapsed >= APPROACH_SECONDS - 1e-12 ? 1 : approach.elapsed / APPROACH_SECONDS;
        camera.position.lerpVectors(approach.start, approach.end, fraction * fraction * (3 - 2 * fraction));
        if (fraction === 1) approach = null;
        syncTarget(); return dt > 0;
      }
      const roll = rollInput(), decay = Math.exp(-dt / LOOK_TAU);
      const yaw = dt > 0 ? mouseX * (Math.abs(mouseX * decay) < LOOK_EPSILON ? 1 : 1 - decay) : 0;
      const pitch = dt > 0 ? mouseY * (Math.abs(mouseY * decay) < LOOK_EPSILON ? 1 : 1 - decay) : 0;
      mouseX -= yaw; mouseY -= pitch;
      const turning = yaw !== 0 || pitch !== 0 || (roll !== 0 && dt > 0);
      if (turning) {
        camera.rotateY(-yaw * sensitivity); camera.rotateX(-pitch * sensitivity); camera.rotateZ(roll * 1.5 * dt); camera.quaternion.normalize();
      }
      orbitPickDelay -= dt;
      // Pure orbit retains one centre through its inertial tail. Mouse aiming
      // may refine it; free flight also remembers surfaces before any orbit key.
      if ((!orbit || yaw !== 0 || pitch !== 0) && orbitPickDelay <= 0) {
        const selected = observeOrbitTarget();
        if (orbit && selected && (yaw !== 0 || pitch !== 0)) {
          orbit.point.fromArray(selected.point); orbit.target = selected;
        }
      }
      if (!orbit && hasOrbitInput() && lastOrbitTarget) beginOrbit(lastOrbitTarget);
      let orbitMoved = false;
      if (orbit && dt > 0) {
        angularDesired.set(keys.has("ShiftRight") ? horizontalOrbitPressed("ArrowRight") - horizontalOrbitPressed("ArrowLeft") : 0,
          keys.has("ShiftRight") ? orbitPressed("ArrowUp") - orbitPressed("ArrowDown") : 0);
        const thrust = angularDesired.lengthSq() > 0, tau = thrust ? 0.25 : 0.4, decay = Math.exp(-dt / tau);
        if (thrust) angularDesired.normalize().multiplyScalar(ORBIT_RATE);
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
        if (!thrust && angularVelocity.lengthSq() === 0 && !hasOrbitInput()) cancelOrbit();
      }
      if (keys.has("ShiftRight")) desired.set(0, 0, 0);
      else desired.set(horizontalPressed("ArrowRight") - horizontalPressed("ArrowLeft"),
        verticalInput(), pressed("ArrowDown") - pressed("ArrowUp"));
      const thrust = desired.lengthSq() > 0;
      if (thrust) desired.normalize().applyQuaternion(camera.quaternion).multiplyScalar(baseSpeed * speedMultiplier);
      const moving = velocity.lengthSq() > epsilon * epsilon || thrust;
      if (moving && dt > 0) {
        if (orbit) movementSegment.start.copy(camera.position);
        const tau = thrust ? 0.25 : 0.4, decay = Math.exp(-dt / tau);
        difference.copy(velocity).sub(desired);
        camera.position.addScaledVector(desired, dt).addScaledVector(difference, tau * (1 - decay));
        velocity.copy(desired).addScaledVector(difference, decay);
        if (!thrust && velocity.lengthSq() < epsilon * epsilon) velocity.set(0, 0, 0);
        if (orbit) {
          movementSegment.end.copy(camera.position);
          movementSegment.closestPointToPoint(orbit.point, true, closest);
          if (closest.distanceToSquared(orbit.point) <= epsilon * epsilon) cancelOrbit(true);
        }
      }
      syncTarget(); return turning || orbitMoved || speedMultiplier !== previousSpeed || (moving && dt > 0);
    },
  };
}

/** Pointer lock owns the lifetime; RAF remains owned by the existing viewport. */
export function createGeometryFlightController({
  THREE, element, getCamera, getTarget, getSpeed = () => 1, canStart = () => true,
  getApproachTarget = () => null, getOrbitTarget = () => null,
  onActivate = () => {}, onDeactivate = () => {}, onStateChange = () => {},
  onError = () => {}, onSpeedChange = () => {}, requestRender = () => {},
}) {
  const owner = element.ownerDocument;
  const win = owner.defaultView;
  let state = "idle", motion = null, lastTime = null, disposed = false, generation = 0;
  let rightControl = false, leftControl = false;
  let lastSpeedNoticeTime = null, initialView = null;
  const heldKeys = new Set(), suppressedKeys = new Set(), activeSpeedKeys = new Set();
  const setState = value => { state = value; onStateChange(value); };
  const locked = () => owner.pointerLockElement === element;
  const controller = {
    get state() { return state; },
    get active() { return state === "active"; },
    get orbitTarget() { return state === "active" ? motion?.orbitTarget : null; },
    get lastOrbitTarget() { return state === "active" ? motion?.lastOrbitTarget : null; },
    get orbiting() { return state === "active" && motion?.orbiting; },
    get approaching() { return state === "active" && motion?.approaching; },
    get speedMultiplier() { return state === "active" ? motion?.speedMultiplier : 1; },
    get linearSpeed() { return state === "active" ? motion?.linearSpeed : 0; },
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
      heldKeys.clear(); suppressedKeys.clear(); activeSpeedKeys.clear();
      motion?.clear(); motion = null; lastTime = null; initialView = null;
      lastSpeedNoticeTime = null;
      if (state !== "idle") setState("idle");
      if (locked()) owner.exitPointerLock();
      if (wasActive) onDeactivate(reason);
      requestRender();
    },
    update(timestamp) {
      if (state !== "active") return;
      const dt = lastTime === null ? 0 : (timestamp - lastTime) / 1000;
      lastTime = timestamp;
      const previousSpeed = motion.speedMultiplier;
      motion.step(dt);
      if (motion.speedMultiplier !== previousSpeed) notifySpeed(timestamp);
      if (!motion.needsFrame) lastTime = null;
    },
    approach(point, stopDistance) {
      if (state !== "active" || !motion.approach(point, stopDistance)) return false;
      for (const code of heldKeys) {
        // Modifiers alone are passive, so a fresh arrow may use the held chord
        // even while repeats of the previous movement key remain suppressed.
        if (code === "ShiftRight") motion.key(code, true);
        else suppressedKeys.add(code);
      }
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
  function notifySpeed(timestamp, force = false) {
    if (force || lastSpeedNoticeTime === null || timestamp - lastSpeedNoticeTime >= 100) {
      onSpeedChange(motion.speedMultiplier);
      lastSpeedNoticeTime = timestamp;
    }
  }
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
      lastTime = null;
      motion.step(0);
      const camera = getCamera();
      initialView = { position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        up: camera.up.clone(), target: getTarget().clone() };
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
    if (FLIGHT_KEYS.has(event.code) || event.code === "KeyA") heldKeys.add(event.code);
    if (suppressedKeys.has(event.code)) { event.preventDefault(); event.stopPropagation(); return; }
    // Right Ctrl moves downward; left Ctrl retains browser shortcuts.
    if (leftControl || (event.ctrlKey && !rightControl) || event.altKey || event.metaKey) {
      motion.releaseKeys(); activeSpeedKeys.clear(); return;
    }
    if (event.code === "KeyA") {
      if (event.ctrlKey || event.shiftKey || rightControl || heldKeys.has("ShiftRight")) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      motion.clear(); activeSpeedKeys.clear(); lastTime = null;
      // Stop held input as well as inertia; only fresh input may move the restored view.
      for (const code of heldKeys) suppressedKeys.add(code);
      const camera = getCamera();
      camera.position.copy(initialView.position); camera.quaternion.copy(initialView.quaternion);
      camera.up.copy(initialView.up); getTarget().copy(initialView.target);
      requestRender(); return;
    }
    if (motion.key(event.code, true)) {
      event.preventDefault(); event.stopPropagation();
      if (speedKey(event.code) || resetSpeedKey(event.code)) {
        activeSpeedKeys.add(event.code); notifySpeed(lastTime, true);
      }
      requestRender();
    }
  }
  function keyUp(event) {
    const wasSpeedActive = activeSpeedKeys.delete(event.code);
    heldKeys.delete(event.code); suppressedKeys.delete(event.code);
    if (event.code === "ControlRight") rightControl = false;
    if (event.code === "ControlLeft") leftControl = false;
    if (state === "active" && motion.key(event.code, false)) {
      event.preventDefault(); event.stopPropagation();
      if (wasSpeedActive) notifySpeed(lastTime, true);
      requestRender();
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
