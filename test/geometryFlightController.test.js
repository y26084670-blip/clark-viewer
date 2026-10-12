import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createGeometryFlightMotion, createGeometryFlightController, GEOMETRY_FLIGHT_HELP, formatGeometryFlightSpeed } from "../src/services/visualization/geometryFlightController.js";

function flight({ orbitTarget } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 3);
  const target = new THREE.Vector3();
  const getOrbitTarget = () => orbitTarget === undefined
    ? { point: camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 3).toArray() } : orbitTarget;
  return { camera, target, getOrbitTarget, motion: createGeometryFlightMotion(THREE, { camera, target, speed: 1, getOrbitTarget }) };
}
function run(f, frames, fps) { for (let i = 0; i < frames; i++) f.motion.step(1 / fps); }
const orbitKey = (motion, code, down = true) => { if (down) motion.key("ShiftRight", true); return motion.key(code, down); };
const rollKey = (motion, code, down = true, enter = "Enter") => { if (down) motion.key(enter, true); return motion.key(code, down); };
const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("acceleration and coasting agree at 30/60/144 FPS with the continuous solution", () => {
  const positions = [];
  for (const fps of [30, 60, 144]) {
    const f = flight();
    f.motion.key("ArrowUp", true); run(f, 2 * fps, fps);
    const distance = 2 - 0.25 * (1 - Math.exp(-8));
    close(f.camera.position.z, 3 - distance);
    f.motion.key("ArrowUp", false); run(f, fps, fps);
    const coast = (1 - Math.exp(-8)) * 0.4 * (1 - Math.exp(-2.5));
    close(f.camera.position.z, 3 - distance - coast);
    positions.push(f.camera.position.z);
  }
  close(Math.max(...positions), Math.min(...positions));
});

test("arrows translate horizontally and in depth; right Ctrl selects screen vertical translation", () => {
  const distance = 1 - .25 * (1 - Math.exp(-4));
  for (const fps of [30, 60, 144]) for (const [code, ctrl, axis, sign] of [
    ["ArrowLeft", false, "x", -1], ["ArrowRight", false, "x", 1],
    ["ArrowUp", false, "z", -1], ["ArrowDown", false, "z", 1],
    ["ArrowUp", true, "y", 1], ["ArrowDown", true, "y", -1],
  ]) {
    const f = flight(), origin = f.camera.position.clone(), gaze = f.camera.quaternion.clone();
    if (ctrl) f.motion.key("ControlRight", true);
    f.motion.key(code, true); run(f, fps, fps);
    for (const component of ["x", "y", "z"]) close(f.camera.position[component] - origin[component], component === axis ? sign * distance : 0);
    assert.deepEqual(f.camera.quaternion.toArray(), gaze.toArray()); assert.equal(f.motion.orbiting, false);
    const projected = new THREE.Vector3(0, 0, 0).project(f.camera);
    if (axis !== "z") assert.ok(projected[axis] * sign < 0, "objects move opposite to the camera");
  }
});

test("linear diagonals have the same speed and screen translation follows the current roll", () => {
  for (const ctrl of [false, true]) {
    const f = flight(), origin = f.camera.position.clone();
    if (ctrl) f.motion.key("ControlRight", true);
    f.motion.key("ArrowRight", true); f.motion.key("ArrowUp", true); run(f, 60, 60);
    close(f.camera.position.distanceTo(origin), 1 - .25 * (1 - Math.exp(-4)));
  }
  const f = flight(); f.camera.rotateZ(Math.PI / 2); const gaze = f.camera.quaternion.clone();
  f.motion.key("ControlRight", true); f.motion.key("ArrowUp", true); run(f, 60, 60);
  assert.ok(f.camera.position.x < -.7); close(f.camera.position.y, 0); close(f.camera.position.z, 3);
  assert.deepEqual(f.camera.quaternion.toArray(), gaze.toArray());
});

test("Q/E are unbound and modifiers alone neither move nor interrupt approach", () => {
  const f = flight(); assert.equal(f.motion.key("KeyQ", true), false); assert.equal(f.motion.key("KeyE", true), false);
  assert.equal(f.motion.key("ShiftLeft", true), false); assert.equal(f.motion.key("ControlLeft", true), false);
  for (const code of ["ControlRight", "ShiftRight", "Enter", "NumpadEnter"]) {
    f.motion.key(code, true); run(f, 60, 60); assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]);
    assert.equal(f.motion.orbiting, false); assert.equal(f.motion.needsFrame, false); f.motion.key(code, false);
  }
  f.motion.approach([0, 0, -10], 1);
  for (const code of ["Enter", "NumpadEnter", "ControlRight", "ShiftRight"]) f.motion.key(code, true);
  assert.equal(f.motion.approaching, true);
});

test("both Enter keys roll with left/right arrows without translation, orbit or a surface hit", () => {
  for (const fps of [30, 60, 144]) for (const enter of ["Enter", "NumpadEnter"]) for (const [code, sign] of [["ArrowLeft", 1], ["ArrowRight", -1]]) {
    const f = flight({ orbitTarget: null }), direction = f.camera.getWorldDirection(new THREE.Vector3());
    rollKey(f.motion, code, true, enter); run(f, fps, fps);
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * 1.5);
    f.camera.quaternion.toArray().forEach((v, i) => close(v, expected.toArray()[i]));
    assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]); close(f.camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction), 0);
    assert.equal(f.motion.orbiting, false); close(f.camera.zoom, 1);
    f.motion.key(code, false); const stopped = f.camera.quaternion.toArray(); run(f, fps, fps);
    assert.deepEqual(f.camera.quaternion.toArray(), stopped); assert.equal(f.motion.needsFrame, false);
  }
});

test("Enter switches a held horizontal arrow between translation, roll and shifted orbit", () => {
  for (const shifted of [false, true]) {
    const f = flight({ orbitTarget: { point: [0, 0, 0] } });
    if (shifted) f.motion.key("ShiftRight", true);
    f.motion.key("ArrowRight", true); run(f, 30, 60); const before = f.camera.position.toArray();
    f.motion.key("Enter", true); run(f, 60, 60);
    assert.deepEqual(f.camera.position.toArray(), before); assert.equal(f.motion.orbiting, false);
    const gaze = f.camera.quaternion.clone(); f.motion.key("Enter", false); run(f, 30, 60);
    assert.notDeepEqual(f.camera.position.toArray(), before); assert.equal(f.motion.orbiting, shifted);
    if (!shifted) assert.deepEqual(f.camera.quaternion.toArray(), gaze.toArray());
  }
  for (const modifier of ["ControlRight", "ShiftRight"]) {
    const f = flight(); f.motion.key(modifier, true); rollKey(f.motion, "ArrowLeft"); run(f, 60, 60);
    assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]); assert.equal(f.motion.orbiting, false); assert.ok(f.camera.up.x < -.9);
  }
});

test("opposite roll arrows cancel and one released Enter does not override the other", () => {
  const f = flight(); f.motion.key("Enter", true); f.motion.key("ArrowLeft", true); f.motion.key("ArrowRight", true);
  run(f, 60, 60); assert.deepEqual(f.camera.quaternion.toArray(), [0, 0, 0, 1]); assert.equal(f.motion.needsFrame, false);
  f.motion.key("ArrowRight", false); f.motion.key("NumpadEnter", true); f.motion.key("Enter", false); run(f, 60, 60);
  assert.ok(f.camera.up.x < -.9); assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]);
  f.motion.key("NumpadEnter", false); const gaze = f.camera.quaternion.toArray(); run(f, 60, 60);
  assert.notDeepEqual(f.camera.position.toArray(), [0, 0, 3]); assert.deepEqual(f.camera.quaternion.toArray(), gaze);
});

test("held Enter survives approach and a fresh horizontal arrow starts roll", () => {
  const f = lifecycle(); f.control.start(); f.event("keydown", { code: "Enter" }); f.event("keydown", { code: "ArrowDown" });
  f.control.approach([0, 0, -10], 1); f.control.update(0); f.control.update(100);
  f.event("keydown", { code: "ArrowDown", repeat: true }); assert.equal(f.control.approaching, true);
  const position = f.camera.position.toArray(); f.event("keydown", { code: "ArrowLeft" }); f.control.update(200);
  assert.equal(f.control.approaching, false); assert.deepEqual(f.camera.position.toArray(), position); assert.ok(f.camera.up.x < 0);
  f.control.dispose();
});

test("speed notices are immediate, throttled during holds, final on release and passive outside flight", () => {
  const f = lifecycle(); f.event("keydown", { code: "Equal" }); assert.deepEqual(f.speedNotices, []);
  f.control.start(); f.control.update(0); f.event("keydown", { code: "Equal" }); assert.deepEqual(f.speedNotices, [1.25]);
  f.control.update(50); assert.equal(f.speedNotices.length, 1);
  f.control.update(100); assert.equal(f.speedNotices.length, 2);
  f.control.update(150); assert.equal(f.speedNotices.length, 2);
  f.control.update(200); assert.equal(f.speedNotices.length, 3);
  f.event("keyup", { code: "Equal" }); close(f.speedNotices.at(-1), f.control.speedMultiplier);
  for (const code of ["Digit0", "Numpad0"]) {
    f.event("keydown", { code }); assert.equal(f.speedNotices.at(-1), 1); f.event("keyup", { code });
  }
  const count = f.speedNotices.length;
  f.event("keydown", { code: "ControlLeft", ctrlKey: true }); f.event("keydown", { code: "Equal", ctrlKey: true });
  f.event("keyup", { code: "ControlLeft" }); f.event("keyup", { code: "Equal" }); assert.equal(f.speedNotices.length, count);
  f.control.dispose(); f.event("keydown", { code: "Minus" }); f.event("keyup", { code: "Minus" }); assert.equal(f.speedNotices.length, count);
  assert.equal(formatGeometryFlightSpeed(1.25), "Скорость ×1,25"); assert.equal(formatGeometryFlightSpeed(1 / 64), "Скорость ×0,016");
});

test("held arrows switch between depth, vertical translation and orbit in either modifier order", () => {
  for (const fps of [30, 60, 144]) {
    const f = flight({ orbitTarget: { point: [0, 0, 0] } });
    f.motion.key("ArrowUp", true); run(f, fps, fps); assert.ok(f.camera.position.z < 3);
    f.motion.key("ControlRight", true); const verticalStart = f.camera.position.clone(); run(f, fps, fps);
    close(f.camera.position.z, verticalStart.z); assert.ok(f.camera.position.y > verticalStart.y); assert.equal(f.motion.orbiting, false);
    f.motion.key("ControlRight", false); const depthStart = f.camera.position.clone(); run(f, fps, fps);
    close(f.camera.position.y, depthStart.y); assert.ok(f.camera.position.z < depthStart.z);
    f.motion.key("ShiftRight", true); const radius = f.camera.position.length(); run(f, fps, fps);
    assert.equal(f.motion.orbiting, true); close(f.camera.position.length(), radius);
    f.motion.key("ShiftRight", false); const linearStart = f.camera.position.clone(), gaze = f.camera.quaternion.clone(); run(f, fps, fps);
    assert.equal(f.motion.orbiting, false); assert.deepEqual(f.camera.quaternion.toArray(), gaze.toArray());
    assert.ok(f.camera.position.distanceTo(linearStart) > .7);
  }
  for (const modifier of ["ControlRight", "ShiftRight"]) for (const first of [true, false]) {
    const f = lifecycle(); f.control.start(); f.control.update(0);
    const keys = first ? [modifier, "ArrowUp"] : ["ArrowUp", modifier];
    let held = false;
    for (const code of keys) {
      if (code === modifier) held = true;
      assert.equal(f.event("keydown", { code, ctrlKey: held && modifier === "ControlRight", shiftKey: held && modifier === "ShiftRight" }).defaultPrevented, true);
    }
    f.control.update(100); f.control.update(200); assert.ok(f.camera.position.y > 0);
    if (modifier === "ControlRight") { close(f.camera.position.z, 3); assert.equal(f.control.orbiting, false); }
    else { close(f.camera.position.length(), 3); assert.equal(f.control.orbiting, true); }
    f.control.dispose();
  }
});

test("opposite arrows and lone modifiers stop idle frames in every keyboard mode", () => {
  for (const modifier of [null, "ControlRight", "ShiftRight"]) for (const pair of [["ArrowLeft", "ArrowRight"], ["ArrowUp", "ArrowDown"]]) {
    const f = flight(); if (modifier) f.motion.key(modifier, true);
    for (const code of pair) f.motion.key(code, true);
    run(f, 60, 60); assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]); assert.equal(f.motion.needsFrame, false);
    for (const code of pair) f.motion.key(code, false);
    assert.equal(f.motion.needsFrame, false); assert.equal(f.motion.orbiting, false);
  }
});

test("flight help describes Enter roll chords and speed controls without former Q/E or boost assignments", () => {
  for (const text of ["←/→ — линейное", "↑/↓ — приближение/удаление", "правый Ctrl+↑/↓", "правый Shift+←/→", "правый Shift+↑/↓", "последний найденный центр", "противоположно взгляду", "+/− — линейная скорость", "0 — штатная скорость ×1", "×1/64…×64", "Enter+←/→ — крен против/по часовой стрелке", "A — начальный вид полёта без выхода"])
    assert.ok(GEOMETRY_FLIGHT_HELP.includes(text), text);
  assert.ok(!GEOMETRY_FLIGHT_HELP.includes("Q/E")); assert.ok(!GEOMETRY_FLIGHT_HELP.includes("×4")); assert.ok(!GEOMETRY_FLIGHT_HELP.includes("+/− — масштаб"));
});

test("a mouse turn leaves accumulated momentum in world space", () => {
  const f = flight(); f.motion.key("ArrowUp", true); run(f, 60, 60);
  f.motion.key("ArrowUp", false);
  const position = f.camera.position.clone();
  f.motion.look(Math.PI / 2 / 0.000625, 0); f.motion.step(0);
  f.motion.step(0.1);
  close(f.camera.position.x, position.x);
  assert.ok(f.camera.position.z < position.z);
  close(f.camera.position.distanceTo(f.target), 3);
  close(f.camera.quaternion.length(), 1);
});

test("vertical orbit follows screen roll, and free mouse look crosses the poles without an Euler clamp", () => {
  const f=flight();rollKey(f.motion,"ArrowLeft");run(f,60,60);f.motion.key("ArrowLeft",false);f.motion.key("Enter",false);
  const origin=f.camera.position.clone();orbitKey(f.motion,"ArrowUp");run(f,60,60);
  assert.ok(f.camera.position.x<-.7);close(f.camera.position.length(),origin.length());assert.ok(f.camera.up.x<-.9);
  const free=flight();free.motion.look(0,Math.PI/.000625);run(free,240,60);
  assert.ok(free.camera.getWorldDirection(new THREE.Vector3()).z>.99);close(free.camera.quaternion.length(),1);
});

test("opposite keys cancel, stale large time steps are bounded, and cleared motion stops", () => {
  const f = flight(); f.motion.key("ArrowUp", true); f.motion.key("ArrowDown", true);
  run(f, 60, 60); close(f.camera.position.z, 3);
  assert.equal(f.motion.needsFrame, false, "opposite held keys must not keep rendering an idle scene");
  f.motion.key("ArrowDown", false); f.motion.step(600);
  assert.ok(f.camera.position.z > 2.98);
  f.motion.clear(); const position = f.camera.position.clone();
  f.motion.step(0.1); assert.deepEqual(f.camera.position, position); assert.equal(f.motion.needsFrame, false);
});

function lifecycle({ pending = false, denied = false, approachTarget = null, orbitTarget,
  activate = () => {}, deactivate = () => {} } = {}) {
  const f = flight({ orbitTarget }), owner = new EventTarget(), win = new EventTarget();
  owner.defaultView = win; owner.hidden = false; owner.pointerLockElement = null;
  const states = [], errors = [], speedNotices = [];
  let permitted = true, renders = 0, exits = 0, activations = 0, deactivations = 0;
  const stopReasons = [];
  const element = { ownerDocument: owner, requestPointerLock() {
    if (denied) return Promise.reject(new Error("denied"));
    if (!pending) grant();
  } };
  owner.exitPointerLock = () => { exits++; owner.pointerLockElement = null; owner.dispatchEvent(new Event("pointerlockchange")); };
  function grant() { owner.pointerLockElement = element; owner.dispatchEvent(new Event("pointerlockchange")); }
  function event(type, values = {}, surface = owner) {
    const e = Object.assign(new Event(type, { cancelable: true }), values); surface.dispatchEvent(e); return e;
  }
  const control = createGeometryFlightController({ THREE, element, getCamera: () => f.camera,
    getTarget: () => f.target, getOrbitTarget: f.getOrbitTarget, canStart: () => permitted, getApproachTarget: () => approachTarget, requestRender: () => renders++,
    onStateChange: state => states.push(state), onError: error => errors.push(error), onSpeedChange: value => speedNotices.push(value),
    onActivate: () => { activations++; activate(f); },
    onDeactivate: reason => { deactivations++; stopReasons.push(reason); deactivate(reason, f); } });
  return { ...f, get camera() { return f.camera; }, set camera(value) { f.camera = value; },
    control, states, errors, speedNotices, owner, win, element, grant, event, stopReasons,
    permit: value => { permitted = value; }, counts: () => ({ renders, exits, activations, deactivations }) };
}


function flightView(f) {
  return { position: f.camera.position.toArray(), quaternion: f.camera.quaternion.toArray(),
    up: f.camera.up.toArray(), target: f.target.toArray() };
}
function assertFlightView(f, expected) {
  const actual = flightView(f);
  for (const key of Object.keys(expected)) actual[key].forEach((value, i) => close(value, expected[key][i]));
}
function advanceController(f, frames, fps, start = 0) {
  for (let i = 0; i <= frames; i++) f.control.update(start + i * 1000 / fps);
}

test("A returns the flight entry pose after translation, mouse look and roll without exiting or losing speed", () => {
  for (const fps of [30, 60, 144]) {
    const f = lifecycle(); f.control.start(); const home = flightView(f);
    f.event("keydown", { code: "Equal" }); f.event("keyup", { code: "Equal" });
    f.event("keydown", { code: "ArrowUp" }); advanceController(f, fps, fps);
    f.event("keyup", { code: "ArrowUp" });
    f.event("mousemove", { movementX: 200, movementY: -130 });
    f.event("keydown", { code: "Enter" }); f.event("keydown", { code: "ArrowRight" });
    advanceController(f, fps / 2, fps, 1000);
    f.event("keyup", { code: "ArrowRight" }); f.event("keyup", { code: "Enter" });
    assert.notDeepEqual(flightView(f), home); assert.equal(f.control.needsFrame, true);
    const counts = f.counts();
    assert.equal(f.event("keydown", { code: "KeyA", key: "ф" }).defaultPrevented, true);
    assertFlightView(f, home); close(f.control.speedMultiplier, 1.25);
    assert.equal(f.control.state, "active"); assert.equal(f.owner.pointerLockElement, f.element);
    assert.equal(f.counts().activations, counts.activations); assert.equal(f.counts().deactivations, 0);
    assert.equal(f.counts().exits, 0); assert.equal(f.control.needsFrame, false);
    advanceController(f, fps, fps, 2000); assertFlightView(f, home);
    assert.equal(f.control.needsFrame, false); f.event("keyup", { code: "KeyA" }); f.control.dispose();
  }
});

test("A clears orbital inertia and the remembered pivot before restoring the flight pose", () => {
  for (const fps of [30, 60, 144]) {
    const f = lifecycle({ orbitTarget: { point: [0, 0, 0] } }); f.control.start();
    const home = flightView(f);
    f.event("keydown", { code: "ShiftRight" }); f.event("keydown", { code: "ArrowLeft" });
    advanceController(f, fps, fps);
    f.event("keyup", { code: "ArrowLeft" }); f.event("keyup", { code: "ShiftRight" });
    assert.equal(f.control.orbiting, true); assert.notDeepEqual(flightView(f), home);
    f.event("keydown", { code: "KeyA" }); assertFlightView(f, home);
    assert.equal(f.control.orbiting, false); assert.equal(f.control.lastOrbitTarget, null);
    assert.equal(f.control.needsFrame, false); advanceController(f, fps, fps, 1000);
    assertFlightView(f, home); assert.equal(f.control.orbiting, false); f.control.dispose();
  }
});

test("A cancels approach and held speed/movement, suppresses repeats, and permits fresh input", () => {
  const f = lifecycle(); f.control.start(); const home = flightView(f);
  f.event("keydown", { code: "Equal" }); f.event("keydown", { code: "ArrowUp" });
  f.control.update(0); f.control.update(100); const speed = f.control.speedMultiplier;
  assert.equal(f.control.approach([0, 0, -10], 1), true);
  f.control.update(200); f.control.update(300); assert.equal(f.control.approaching, true);
  f.event("keydown", { code: "KeyA" }); assertFlightView(f, home);
  assert.equal(f.control.approaching, false); assert.equal(f.control.needsFrame, false);
  for (const code of ["ArrowUp", "Equal", "KeyA"])
    assert.equal(f.event("keydown", { code, repeat: true }).defaultPrevented, true);
  advanceController(f, 60, 60, 400); assertFlightView(f, home); close(f.control.speedMultiplier, speed);
  const notices = f.speedNotices.length;
  f.event("keyup", { code: "Equal" }); f.event("keyup", { code: "ArrowUp" });
  assert.equal(f.speedNotices.length, notices);
  f.event("keydown", { code: "ArrowRight" }); advanceController(f, 30, 60, 1500);
  assert.ok(f.camera.position.x > 0);
  const moved = f.camera.position.x;
  f.event("keydown", { code: "KeyA", repeat: true }); assert.ok(f.camera.position.x >= moved);
  f.event("keyup", { code: "ArrowRight" }); f.event("keyup", { code: "KeyA" });
  f.event("keydown", { code: "KeyA" }); assertFlightView(f, home); close(f.control.speedMultiplier, speed);
  f.control.dispose();
});

test("flight A uses its physical code and ignores modified or composing shortcuts", () => {
  const f = lifecycle(); f.control.start();
  f.event("keydown", { code: "ArrowRight" }); advanceController(f, 20, 60);
  f.event("keyup", { code: "ArrowRight" }); const moved = flightView(f);
  for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true },
    { shiftKey: true }, { isComposing: true }]) {
    assert.equal(f.event("keydown", { code: "KeyA", ...modifiers }).defaultPrevented, false);
    assertFlightView(f, moved); f.event("keyup", { code: "KeyA" });
  }
  assert.equal(f.event("keydown", { code: "KeyF", key: "a" }).defaultPrevented, false);
  assertFlightView(f, moved);
  f.event("keydown", { code: "ControlRight" });
  assert.equal(f.event("keydown", { code: "KeyA", ctrlKey: true }).defaultPrevented, false);
  assertFlightView(f, moved); f.event("keyup", { code: "KeyA" }); f.event("keyup", { code: "ControlRight" });
  f.event("keydown", { code: "ShiftRight" });
  assert.equal(f.event("keydown", { code: "KeyA", shiftKey: true }).defaultPrevented, false);
  assertFlightView(f, moved); f.event("keyup", { code: "KeyA" }); f.event("keyup", { code: "ShiftRight" });
  f.event("keydown", { code: "KeyA", key: "ф" }); close(f.camera.position.x, 0); f.control.dispose();
});

test("A and Ctrl+A remain unconsumed outside active flight, including a pending lock and after exit", () => {
  const f = lifecycle({ pending: true });
  for (const stage of ["idle", "starting", "idle"]) {
    if (stage === "starting") f.control.start();
    else if (f.control.state === "starting") f.control.stop();
    const before = flightView(f);
    for (const ctrlKey of [false, true]) {
      assert.equal(f.event("keydown", { code: "KeyA", ctrlKey }).defaultPrevented, false);
      assert.equal(f.event("keyup", { code: "KeyA", ctrlKey }).defaultPrevented, false);
      assertFlightView(f, before);
    }
  }
  f.control.start(); f.grant(); f.event("keydown", { code: "Escape" });
  assert.equal(f.event("keydown", { code: "KeyA" }).defaultPrevented, false); f.control.dispose();
});

test("A captures the post-activation perspective pose each session and keeps the pre-flight Escape/unlock view separate", () => {
  for (const orthographic of [false, true]) for (const reason of ["escape", "unlock"]) {
    let previous;
    const f = lifecycle({
      activate: scene => {
        previous = { camera: scene.camera, target: scene.target.clone() };
        const perspective = new THREE.PerspectiveCamera(53, 1.7, .02, 900);
        perspective.position.copy(scene.camera.position); perspective.quaternion.copy(scene.camera.quaternion);
        perspective.up.copy(scene.camera.up); perspective.zoom = scene.camera.zoom;
        perspective.updateProjectionMatrix(); scene.camera = perspective;
      },
      deactivate: (why, scene) => {
        if (why === "escape" || why === "unlock") {
          scene.camera = previous.camera; scene.target.copy(previous.target);
        }
      },
    });
    if (orthographic) f.camera = new THREE.OrthographicCamera(-3, 3, 2, -2, .05, 400);
    f.camera.position.set(4, -2, 8); f.camera.up.set(0, 0, 1); f.target.set(1, 2, 0);
    f.camera.lookAt(f.target); f.camera.zoom = 1.8; f.camera.updateProjectionMatrix();
    const original = f.camera, originalView = flightView(f), projection = original.projectionMatrix.toArray();
    f.control.start(); const home = flightView(f), activeCamera = f.camera;
    assert.equal(activeCamera.isPerspectiveCamera, true); assert.notEqual(activeCamera, original);
    f.event("keydown", { code: "NumpadAdd" }); f.event("keyup", { code: "NumpadAdd" });
    f.event("keydown", { code: "ArrowLeft" }); advanceController(f, 30, 60);
    f.event("keyup", { code: "ArrowLeft" }); f.event("keydown", { code: "KeyA" });
    assertFlightView(f, home); assert.equal(f.camera, activeCamera); close(f.control.speedMultiplier, 1.25);
    if (reason === "escape") f.event("keydown", { code: "Escape" });
    else { f.owner.pointerLockElement = null; f.owner.dispatchEvent(new Event("pointerlockchange")); }
    assert.equal(f.control.state, "idle"); assert.equal(f.camera, original); assertFlightView(f, originalView);
    assert.deepEqual(f.camera.projectionMatrix.toArray(), projection);
    f.camera.position.set(9, 1, 6); f.target.set(2, 0, 1); f.camera.lookAt(f.target);
    f.control.start(); const secondHome = flightView(f); assert.notDeepEqual(secondHome, home);
    close(f.control.speedMultiplier, 1);
    f.event("keydown", { code: "ArrowRight" }); advanceController(f, 10, 60);
    f.event("keyup", { code: "ArrowRight" }); f.event("keydown", { code: "KeyA" });
    assertFlightView(f, secondHome); assert.equal(f.control.active, true); f.control.dispose();
  }
});

test("flight activates only after pointer lock and releases keyboard/momentum on Escape", () => {
  const f = lifecycle({ pending: true });
  f.control.start(); assert.equal(f.control.state, "starting");
  f.event("keydown", { code: "ArrowUp" });
  f.control.update(100); assert.equal(f.camera.position.z, 3);
  f.grant(); assert.equal(f.control.active, true);
  assert.equal(f.event("keydown", { code: "ArrowUp", key: "↑" }).defaultPrevented, true);
  f.control.update(100); f.control.update(200); assert.ok(f.camera.position.z < 3);
  f.event("keydown", { code: "Escape" });
  assert.equal(f.control.state, "idle"); assert.equal(f.owner.pointerLockElement, null);
  const position = f.camera.position.clone(); f.control.update(300);
  assert.deepEqual(f.camera.position, position); assert.equal(f.control.needsFrame, false);
  assert.deepEqual(f.states, ["starting", "active", "idle"]);
  f.control.start(); f.control.update(1000); assert.equal(f.control.needsFrame, false);
  f.control.dispose();
});

test("blur, hidden document, browser unlock and disposal stop flight without leaving handlers", () => {
  for (const action of ["blur", "hidden", "unlock", "dispose"]) {
    const f = lifecycle(); f.control.start();
    f.event("keydown", { code: "Enter" }); f.event("keydown", { code: "ArrowLeft", key: "←" });
    if (action === "blur") f.event("blur", {}, f.win);
    if (action === "hidden") { f.owner.hidden = true; f.event("visibilitychange"); }
    if (action === "unlock") { f.owner.pointerLockElement = null; f.event("pointerlockchange"); }
    if (action === "dispose") f.control.dispose();
    assert.equal(f.control.state, "idle", action);
    assert.equal(f.owner.pointerLockElement, null, action);
    assert.equal(f.counts().deactivations, 1, action);
    f.control.dispose(); const before = f.counts().renders;
    f.event("keydown", { code: "ArrowUp" }); f.event("mousemove", { movementX: 100, movementY: 50 });
    assert.equal(f.counts().renders, before);
  }
});

test("failed, cancelled and stale pointer-lock requests return to idle without activating", async () => {
  const denied = lifecycle({ denied: true }); denied.control.start();
  await Promise.resolve(); assert.equal(denied.control.state, "idle"); assert.equal(denied.errors.length, 1);
  assert.equal(denied.counts().activations, 0); denied.control.dispose();
  const cancelled = lifecycle({ pending: true }); cancelled.control.start(); cancelled.control.stop(); cancelled.grant();
  assert.equal(cancelled.control.state, "idle"); assert.equal(cancelled.owner.pointerLockElement, null);
  assert.equal(cancelled.counts().activations, 0); cancelled.control.dispose();
  const stale = lifecycle({ pending: true }); stale.control.start(); stale.permit(false); stale.grant();
  assert.equal(stale.control.state, "idle"); assert.equal(stale.counts().activations, 0); stale.control.dispose();
});

test("modifier shortcuts release motion and Enter roll uses physical arrow codes in every layout", () => {
  const f = lifecycle(); f.control.start(); f.control.update(0);
  f.event("keydown", { code: "Enter" }); f.event("keydown", { code: "ArrowLeft", key: "←" }); f.control.update(100); f.control.update(200);
  assert.ok(f.camera.up.x < 0); f.event("keyup", { code: "ArrowLeft" }); f.event("keyup", { code: "Enter" });
  f.event("keydown", { code: "ArrowUp", ctrlKey: true });
  const position = f.camera.position.clone(); f.control.update(300);
  assert.deepEqual(f.camera.position, position);
  f.control.dispose();
});

test("right Ctrl modifies vertical translation and composes with speed controls without browser shortcuts", () => {
  const f = lifecycle(); f.control.start(); f.control.update(0);
  const gaze = f.camera.quaternion.clone();
  assert.equal(f.event("keydown", { code: "Enter" }).defaultPrevented, true);
  assert.equal(f.event("keydown", { code: "ControlRight", ctrlKey: true }).defaultPrevented, true);
  f.control.update(100); assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]);
  assert.equal(f.event("keydown", { code: "ArrowUp", ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.event("keydown", { code: "Equal", ctrlKey: true, shiftKey: true }).defaultPrevented, true);
  f.control.update(200); f.control.update(300);
  assert.ok(f.camera.position.y > 0); close(f.camera.position.z, 3); close(f.camera.zoom, 1); assert.ok(f.control.speedMultiplier > 1);
  assert.deepEqual(f.camera.quaternion.toArray(), gaze.toArray()); assert.equal(f.control.orbiting, false);
  f.event("keyup", { code: "ControlRight", ctrlKey: false });
  f.event("keyup", { code: "ArrowUp" }); f.event("keyup", { code: "Equal" }); f.control.dispose();
  const down = flight(); down.motion.key("ControlRight", true); down.motion.key("ArrowDown", true); run(down, 60, 60);
  assert.ok(down.camera.position.y < -.7); close(down.camera.position.z, 3);
  assert.equal(down.motion.key("PageUp", true), false); assert.equal(down.motion.key("PageDown", true), false);
});

test("speed taps and holds are reversible and frame-rate independent without changing either camera projection", () => {
  for (const Camera of [THREE.PerspectiveCamera, THREE.OrthographicCamera]) {
    const multipliers = [];
    for (const fps of [30, 60, 144]) {
      const camera = new Camera(), target = new THREE.Vector3(0, 0, -3);
      camera.zoom = 2.7; camera.updateProjectionMatrix();
      const f = { motion: createGeometryFlightMotion(THREE, { camera, target, speed: 3 }) };
      const position = camera.position.clone(), quaternion = camera.quaternion.clone(), projection = camera.projectionMatrix.toArray();
      f.motion.key("NumpadAdd", true); run(f, fps, fps); f.motion.key("NumpadAdd", false);
      multipliers.push(f.motion.speedMultiplier); close(f.motion.speedMultiplier, 2.5); close(f.motion.linearSpeed, 7.5);
      assert.deepEqual(camera.position, position); assert.deepEqual(camera.quaternion.toArray(), quaternion.toArray());
      assert.deepEqual(camera.projectionMatrix.toArray(), projection); close(camera.zoom, 2.7);
      f.motion.key("Minus", true); run(f, fps, fps); f.motion.key("Minus", false);
      close(f.motion.speedMultiplier, 1); assert.equal(f.motion.needsFrame, false);
      // A short tap changes the setting even when keyup precedes the next frame.
      f.motion.key("Equal", true); f.motion.key("Equal", false); f.motion.step(0);
      close(f.motion.speedMultiplier, 1.25);
      f.motion.key("NumpadSubtract", true); f.motion.key("NumpadSubtract", false); f.motion.step(0);
      close(f.motion.speedMultiplier, 1); assert.deepEqual(camera.projectionMatrix.toArray(), projection);
    }
    close(Math.max(...multipliers), Math.min(...multipliers));
  }
});

test("opposite speed keys cancel, bounds stop idle frames, and either zero restores the default", () => {
  const f = flight();
  for (const code of ["Equal", "Minus", "ArrowUp", "ArrowDown", "ControlRight"]) f.motion.key(code, true);
  run(f, 60, 60); close(f.motion.speedMultiplier, 1); close(f.camera.position.y, 0); close(f.camera.zoom, 1);
  assert.equal(f.motion.needsFrame, false); f.motion.releaseKeys();
  for (const [code, bound] of [["Equal", 64], ["NumpadSubtract", 1 / 64]]) {
    f.motion.key(code, true); run(f, 900, 60); close(f.motion.speedMultiplier, bound);
    assert.equal(f.motion.needsFrame, false, "a clamped setting must not keep RAF alive"); f.motion.key(code, false);
    for (const reset of ["Digit0", "Numpad0"]) {
      f.motion.key(reset, true); close(f.motion.speedMultiplier, 1); close(f.motion.linearSpeed, 1);
      assert.equal(f.motion.needsFrame, false); f.motion.key(reset, false);
    }
  }
  assert.deepEqual(f.camera.position.toArray(), [0, 0, 3]); close(f.camera.zoom, 1);
});

test("key repeats do not add taps and held aliases use one continuous adjustment rate", () => {
  const f = flight(); f.motion.key("Equal", true);
  for (let repeat = 0; repeat < 40; repeat++) f.motion.key("Equal", true);
  close(f.motion.speedMultiplier, 1.25); run(f, 60, 60); close(f.motion.speedMultiplier, 2.5);
  f.motion.key("NumpadAdd", true); close(f.motion.speedMultiplier, 3.125);
  run(f, 60, 60); close(f.motion.speedMultiplier, 6.25);
  f.motion.key("Digit0", true); close(f.motion.speedMultiplier, 1); run(f, 60, 60); close(f.motion.speedMultiplier, 1);
  f.motion.key("Minus", true); close(f.motion.speedMultiplier, 1);
  f.motion.key("Digit0", false); run(f, 60, 60); close(f.motion.speedMultiplier, 1);
});

test("selected speed scales every linear direction and its inertia at 30/60/144 FPS", () => {
  for (const fps of [30, 60, 144]) for (const [code, ctrl] of [
    ["ArrowLeft", false], ["ArrowRight", false], ["ArrowUp", false], ["ArrowDown", false], ["ArrowUp", true], ["ArrowDown", true],
  ]) {
    const normal = flight(), fast = flight(), start = normal.camera.position.clone();
    fast.motion.key("Equal", true); fast.motion.key("Equal", false);
    for (const f of [normal, fast]) { if (ctrl) f.motion.key("ControlRight", true); f.motion.key(code, true); run(f, fps, fps); }
    close(fast.camera.position.distanceTo(start), normal.camera.position.distanceTo(start) * 1.25);
    for (const f of [normal, fast]) { f.motion.key(code, false); run(f, fps, fps); }
    close(fast.camera.position.distanceTo(start), normal.camera.position.distanceTo(start) * 1.25);
    assert.deepEqual(fast.camera.quaternion.toArray(), normal.camera.quaternion.toArray()); close(fast.camera.zoom, normal.camera.zoom);
  }
});

test("speed changes and zero affect held movement smoothly without teleporting or resetting inertia", () => {
  for (const fps of [30, 60, 144]) {
    const f = flight(); f.motion.key("ArrowRight", true); run(f, fps, fps);
    const start = f.camera.position.x, v1 = 1 - Math.exp(-4);
    f.motion.key("Equal", true); f.motion.key("Equal", false); close(f.camera.position.x, start);
    run(f, fps, fps); close(f.camera.position.x, start + 1.25 + (v1 - 1.25) * .25 * (1 - Math.exp(-4)));
    const resetStart = f.camera.position.x, v2 = 1.25 + (v1 - 1.25) * Math.exp(-4);
    f.motion.key("Numpad0", true); f.motion.key("Numpad0", false); close(f.camera.position.x, resetStart); close(f.motion.speedMultiplier, 1);
    run(f, fps, fps); close(f.camera.position.x, resetStart + 1 + (v2 - 1) * .25 * (1 - Math.exp(-4)));
    close(f.camera.position.y, 0); close(f.camera.position.z, 3); close(f.camera.zoom, 1);
  }
});

test("linear speed settings do not alter orbital speed, its centre or radius", () => {
  for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) for (const factor of [1 / 64, 64]) {
    const normal = flight(), adjusted = flight();
    adjusted.motion.key(factor < 1 ? "Minus" : "Equal", true); run(adjusted, 900, 60);
    adjusted.motion.key(factor < 1 ? "Minus" : "Equal", false); close(adjusted.motion.speedMultiplier, factor);
    for (const f of [normal, adjusted]) { orbitKey(f.motion, code); run(f, 120, 60); }
    assert.deepEqual(adjusted.camera.position.toArray(), normal.camera.position.toArray());
    assert.deepEqual(adjusted.camera.quaternion.toArray(), normal.camera.quaternion.toArray());
    assert.deepEqual(adjusted.motion.orbitTarget.point, normal.motion.orbitTarget.point); close(adjusted.camera.position.length(), 3);
  }
});

test("speed persists through automatic approach and key release, then a new flight restores the default", () => {
  const f = lifecycle(); f.control.start();
  assert.equal(f.event("keydown", { code: "NumpadAdd" }).defaultPrevented, true);
  f.event("keyup", { code: "NumpadAdd" }); close(f.control.speedMultiplier, 1.25);
  f.control.approach([0, 0, -10], 1); f.control.update(0);
  for (let t = 100; t <= 600; t += 100) f.control.update(t);
  assert.equal(f.control.approaching, false); close(f.camera.position.z, -9); close(f.control.speedMultiplier, 1.25);
  f.event("keydown", { code: "ControlLeft", ctrlKey: true }); f.event("keyup", { code: "ControlLeft" }); close(f.control.speedMultiplier, 1.25);
  for (const code of ["Digit0", "Numpad0"]) {
    assert.equal(f.event("keydown", { code }).defaultPrevented, true); close(f.control.speedMultiplier, 1); f.event("keyup", { code });
    f.event("keydown", { code: "Equal" }); f.event("keyup", { code: "Equal" }); close(f.control.speedMultiplier, 1.25);
  }
  f.control.stop(); close(f.control.speedMultiplier, 1); f.control.start(); close(f.control.speedMultiplier, 1); f.control.dispose();
});

test("mouse angles are smoothed with tau=0.25s, conserve the requested turn and settle at every frame rate", () => {
  for (const fps of [30, 60, 144]) {
    const f = flight(); f.motion.look(200, 0); f.motion.step(0);
    assert.deepEqual(f.camera.quaternion.toArray(), [0, 0, 0, 1]);
    run(f, fps, fps);
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.125 * (1 - Math.exp(-4)));
    f.camera.quaternion.toArray().forEach((value, i) => close(value, expected.toArray()[i]));
    const moving = f.camera.quaternion.clone(); run(f, fps, fps);
    assert.notDeepEqual(f.camera.quaternion.toArray(), moving.toArray(), "rotation continues after the last mouse event");
    run(f, 2 * fps, fps); assert.equal(f.motion.needsFrame, false);
    const final = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.125);
    f.camera.quaternion.toArray().forEach((value, i) => close(value, final.toArray()[i]));
    const settled = f.camera.quaternion.toArray(); run(f, fps, fps); assert.deepEqual(f.camera.quaternion.toArray(), settled);
  }
});

test("approach follows a monotone straight line for 0.5s, stops at the requested distance and clears momentum", () => {
  for (const fps of [30, 60, 144]) {
    const f = flight(), destination = new THREE.Vector3(10, 5, -4);
    f.motion.key("ArrowUp", true); run(f, 12, 60);
    const start = f.camera.position.clone(), direction = destination.clone().sub(start).normalize();
    assert.equal(f.motion.approach(destination.toArray(), 0.5), true);
    let previous = 0;
    for (let i = 0; i < fps / 2; i++) {
      f.motion.step(1 / fps);
      const displacement = f.camera.position.clone().sub(start);
      assert.ok(displacement.clone().cross(direction).length() < 1e-11);
      assert.ok(displacement.length() >= previous); previous = displacement.length();
      assert.ok(f.camera.position.distanceTo(destination) >= 0.5 - 1e-11);
    }
    close(f.camera.position.distanceTo(destination), 0.5);
    assert.equal(f.motion.approaching, false); assert.equal(f.motion.needsFrame, false);
    const arrived = f.camera.position.clone(); run(f, fps, fps); assert.deepEqual(f.camera.position, arrived);
    assert.equal(f.motion.approach([NaN, 0, 0], 1), false);
    assert.equal(f.motion.approach([0, 0, 0], 0), false);
  }
});

test("new manual keys or nonzero mouse input interrupt approach at the current position", () => {
  for (const input of ["key", "mouse", "clear"]) {
    const f = flight(); f.motion.approach([0, 0, -10], 1); f.motion.step(0.1);
    const position = f.camera.position.clone(); f.motion.look(0, 0); assert.equal(f.motion.approaching, true);
    if (input === "key") orbitKey(f.motion,"ArrowUp");
    if (input === "mouse") f.motion.look(20, 0);
    if (input === "clear") f.motion.clear();
    assert.equal(f.motion.approaching, false); f.motion.step(0.1);
    if (input === "key") {
      assert.ok(f.camera.position.y > position.y);assert.equal(f.motion.orbiting,true);
      close(f.camera.position.distanceTo(new THREE.Vector3().fromArray(f.motion.orbitTarget.point)),3);
    } else assert.deepEqual(f.camera.position, position);
  }
});

test("left click approaches the retained target; held repeats are suppressed and stop/dispose cancel travel", () => {
  const f = lifecycle({ approachTarget: { point: [0, 0, -10], stopDistance: 1 } });
  f.event("click", { button: 0 }); assert.equal(f.control.approaching, false);
  f.control.start(); f.event("keydown", { code: "ArrowUp" }); f.control.update(0); f.control.update(100);
  f.event("click", { button: 2 }); assert.equal(f.control.approaching, false);
  assert.equal(f.event("click", { button: 0 }).defaultPrevented, true); assert.equal(f.control.approaching, true);
  f.event("keydown", { code: "ArrowUp", repeat: true }); assert.equal(f.control.approaching, true);
  for (let time = 200; time <= 700; time += 100) f.control.update(time);
  close(f.camera.position.z, -9); assert.equal(f.control.needsFrame, false);
  f.event("keyup", { code: "ArrowUp" }); f.event("keydown", { code: "ArrowRight" });
  f.control.update(800); f.control.update(900); assert.ok(f.camera.position.x > 0);
  f.control.approach([0, 0, -20], 1); f.control.update(1000); f.control.update(1100);
  f.event("keydown", { code: "Escape" }); const stopped = f.camera.position.clone();
  f.control.update(1200); assert.deepEqual(f.camera.position, stopped);
  f.control.dispose(); const before = f.counts().renders;
  f.event("click", { button: 0 }); assert.equal(f.counts().renders, before);
});

test("approach suppresses old arrow repeats but fresh arrows keep the held right modifier", () => {
  for (const modifier of ["ControlRight", "ShiftRight"]) {
    const f = lifecycle(); f.control.start();
    f.event("keydown", { code: modifier, ctrlKey: modifier === "ControlRight", shiftKey: modifier === "ShiftRight" });
    f.event("keydown", { code: "ArrowLeft", ctrlKey: modifier === "ControlRight", shiftKey: modifier === "ShiftRight" });
    assert.equal(f.control.approach([0, 0, -10], 1), true); f.control.update(0); f.control.update(100);
    f.event("keydown", { code: "ArrowLeft", repeat: true, ctrlKey: modifier === "ControlRight", shiftKey: modifier === "ShiftRight" });
    assert.equal(f.control.approaching, true);
    const before = f.camera.position.clone();
    f.event("keydown", { code: "ArrowUp", ctrlKey: modifier === "ControlRight", shiftKey: modifier === "ShiftRight" });
    assert.equal(f.control.approaching, false); f.control.update(200);
    assert.ok(f.camera.position.y > before.y);
    assert.equal(f.control.orbiting, modifier === "ShiftRight");
    if (modifier === "ControlRight") close(f.camera.position.z, before.z);
    f.control.dispose();
  }
});


test("Escape/browser unlock request view restoration, while blur and programmatic stops keep their separate lifecycle", () => {
  for(const reason of ["escape","unlock","blur","stop"]) {
    const f=lifecycle();f.control.start();
    if(reason==="escape")f.event("keydown",{code:"Escape"});
    if(reason==="unlock"){f.owner.pointerLockElement=null;f.owner.dispatchEvent(new Event("pointerlockchange"));}
    if(reason==="blur")f.event("blur",{},f.win);
    if(reason==="stop")f.control.stop();
    assert.deepEqual(f.stopReasons,[reason]);f.control.stop();f.control.dispose();assert.deepEqual(f.stopReasons,[reason]);
  }
});


test("all four orbit keys keep the picked point centred and conserve radius at 30/60/144 FPS", () => {
  const rate=Math.PI/6,angle=rate*(2-.25*(1-Math.exp(-8))),coast=rate*(1-Math.exp(-8))*.4*(1-Math.exp(-2.5));
  for(const fps of [30,60,144])for(const [code,axis,sign] of [["ArrowRight","x",1],["ArrowLeft","x",-1],["ArrowUp","y",1],["ArrowDown","y",-1]]) {
    const f=flight();orbitKey(f.motion,code);run(f,2*fps,fps);
    close(f.camera.position[axis],sign*3*Math.sin(angle));close(f.camera.position.z,3*Math.cos(angle));close(f.camera.position.length(),3);
    close(f.camera.getWorldDirection(new THREE.Vector3()).dot(f.camera.position.clone().normalize().negate()),1);
    assert.deepEqual(f.motion.orbitTarget.point,[0,0,0]);
    f.motion.key(code,false);run(f,fps,fps);close(f.camera.position[axis],sign*3*Math.sin(angle+coast));
    assert.equal(f.motion.orbiting,true,"the centre must survive the inertial tail");
    run(f,5*fps,fps);assert.equal(f.motion.orbiting,false);assert.equal(f.motion.needsFrame,false);close(f.camera.position.length(),3);
  }
});

test("diagonal orbit is normalized and right Shift selects 30 degrees per second without a boost", () => {
  for(const fps of [30,60,144]) {
    const angle=Math.PI/6*(1-.25*(1-Math.exp(-4)));
    for(const ctrl of [false,true]) {
      const f=flight(); if(ctrl)f.motion.key("ControlRight",true);
      orbitKey(f.motion,"ArrowRight");f.motion.key("ArrowUp",true);
      run(f,fps,fps);close(f.camera.position.length(),3);close(f.camera.position.z,3*Math.cos(angle));
      close(f.camera.position.x,f.camera.position.y);assert.ok(f.camera.position.x>0);close(f.camera.quaternion.length(),1);
    }
  }
});

test("a gesture retains its pivot through repeats/coasting and mouse aiming refines it without cancellation", () => {
  const f=flight();let calls=0;const points=[[0,0,0],[2,1,0]];
  const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>({point:points[Math.min(calls++,1)]})});
  orbitKey(motion,"ArrowRight");for(let i=0;i<60;i++)motion.step(1/60);orbitKey(motion,"ArrowRight");
  assert.equal(calls,1);motion.key("ArrowRight",false);motion.step(.1);assert.deepEqual(motion.orbitTarget.point,points[0]);
  orbitKey(motion,"ArrowUp");assert.equal(calls,1);motion.look(20,0);assert.equal(motion.orbiting,true);
  motion.step(.1);assert.equal(calls,2);assert.equal(motion.orbiting,true);assert.deepEqual(motion.orbitTarget.point,points[1]);
  points[1][0]=99;assert.equal(motion.orbitTarget.point[0],2,"retain a numeric copy of the selected pivot");
});

test("an empty reticle never invents a centre or keeps RAF running; held input starts after its first hit", () => {
  for(const code of ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"]) {
    const f=flight();let calls=0,available=false;
    const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>{calls++;return available?{point:[0,0,0]}:null;}});
    const before=f.camera.position.clone();assert.equal(orbitKey(motion,code),true);motion.step(.1);assert.deepEqual(f.camera.position,before);
    assert.equal(motion.needsFrame,false);assert.equal(motion.orbiting,false);assert.equal(motion.lastOrbitTarget,null);
    available=true;motion.look(1,0);motion.step(.1);assert.equal(motion.orbiting,true);
    assert.ok(calls>=2);assert.deepEqual(motion.orbitTarget.point,[0,0,0]);
  }
});

test("mouse misses retain the last centre, held rotation and angular inertia at every frame rate", () => {
  for (const fps of [30,60,144]) {
    const f=flight();let hit={point:[0,0,0],label:"remembered"};
    const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>hit});
    orbitKey(motion,"ArrowRight");for(let i=0;i<fps;i++)motion.step(1/fps);
    hit=null;motion.look(2500,400);const before=f.camera.position.clone();
    for(let i=0;i<fps;i++)motion.step(1/fps);
    assert.equal(motion.orbiting,true);assert.deepEqual(motion.orbitTarget.point,[0,0,0]);
    assert.ok(f.camera.position.distanceTo(before)>1);close(f.camera.position.length(),3);
    motion.key("ArrowRight",false);for(let i=0;i<6*fps;i++)motion.step(1/fps);
    assert.equal(motion.orbiting,false);assert.deepEqual(motion.lastOrbitTarget.point,[0,0,0]);
    const quaternion=f.camera.quaternion.clone();orbitKey(motion,"ArrowUp");
    assert.equal(motion.orbiting,true);assert.deepEqual(f.camera.quaternion.toArray(),quaternion.toArray(),"fallback must not turn the gaze back to the old centre");
    motion.clear();assert.equal(motion.lastOrbitTarget,null);orbitKey(motion,"ArrowUp");motion.step(.1);
    assert.equal(motion.orbiting,false);assert.equal(motion.needsFrame,false);
  }
});

test("free flight remembers a surface before the first orbit and manual interruption of approach retains it", () => {
  const f=flight();let hit={point:[0,0,0]};
  const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>hit});
  motion.step(0);assert.deepEqual(motion.lastOrbitTarget.point,[0,0,0]);
  hit=null;motion.look(1500,0);motion.step(.1);assert.equal(motion.orbiting,false);
  const gaze=f.camera.quaternion.clone();orbitKey(motion,"ArrowLeft");assert.equal(motion.orbiting,true);assert.deepEqual(f.camera.quaternion.toArray(),gaze.toArray());
  motion.approach([0,0,0],.3);assert.deepEqual(motion.lastOrbitTarget.point,[0,0,0]);
  orbitKey(motion,"ArrowUp");assert.equal(motion.approaching,false);assert.equal(motion.orbiting,true);
  motion.clear();assert.equal(motion.lastOrbitTarget,null);
});

test("new linear input ends an orbit tail without losing the last centre", () => {
  const f=flight();let hit={point:[0,0,0]};
  const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>hit});
  orbitKey(motion,"ArrowRight");hit=null;motion.look(Math.PI/.000625,0);
  for(let i=0;i<60;i++)motion.step(1/60);
  motion.key("ArrowRight",false);motion.key("ShiftRight",false);motion.step(.1);
  assert.equal(motion.orbiting,true);assert.deepEqual(motion.orbitTarget.point,[0,0,0]);
  motion.key("ArrowUp",true);assert.equal(motion.orbiting,false);
  for(let i=0;i<60;i++)motion.step(1/60);
  assert.deepEqual(motion.lastOrbitTarget.point,[0,0,0]);
  assert.ok(f.camera.position.toArray().every(Number.isFinite));close(f.camera.quaternion.length(),1);
  assert.ok(f.camera.getWorldDirection(new THREE.Vector3()).dot(f.target.clone().sub(f.camera.position).normalize())>.999999999);
});

test("leaving flight discards its remembered centre before a new session starts", () => {
  const selected={point:[0,0,0]},f=lifecycle({orbitTarget:selected});
  f.control.start();f.control.update(0);assert.deepEqual(f.control.lastOrbitTarget.point,[0,0,0]);
  f.control.stop();assert.equal(f.control.lastOrbitTarget,null);selected.point.fill(NaN);
  f.control.start();f.control.update(0);f.event("keydown",{code:"ShiftRight"});f.event("keydown",{code:"ArrowRight",shiftKey:true});f.control.update(16);
  assert.equal(f.control.orbiting,false);assert.equal(f.control.lastOrbitTarget,null);assert.equal(f.control.needsFrame,false);
  f.control.dispose();
});

test("vertical orbit crosses both poles and its complete chord release keeps angular inertia", () => {
  const f=flight();orbitKey(f.motion,"ArrowUp");run(f,600,60);close(f.camera.position.length(),3);close(f.camera.quaternion.length(),1);
  const before=f.camera.position.clone();f.motion.key("ArrowUp",false);f.motion.key("ShiftRight",false);run(f,12,60);
  assert.equal(f.motion.orbiting,true);assert.ok(f.camera.position.distanceTo(before)>0);close(f.camera.position.length(),3);
  run(f,360,60);assert.equal(f.motion.orbiting,false);assert.equal(f.motion.needsFrame,false);
});
