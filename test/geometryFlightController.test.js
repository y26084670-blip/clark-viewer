import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createGeometryFlightMotion, createGeometryFlightController } from "../src/services/visualization/geometryFlightController.js";

function flight() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 3);
  const target = new THREE.Vector3();
  return { camera, target, motion: createGeometryFlightMotion(THREE, { camera, target, speed: 1 }) };
}
function run(f, frames, fps) { for (let i = 0; i < frames; i++) f.motion.step(1 / fps); }
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

test("diagonal thrust has the same speed and only the right Shift gives a 4x boost", () => {
  const forward = flight(), diagonal = flight(), boost = flight(), leftShift = flight();
  for (const f of [forward, diagonal, boost, leftShift]) f.motion.key("ArrowUp", true);
  diagonal.motion.key("ArrowRight", true);
  boost.motion.key("ShiftRight", true);
  assert.equal(leftShift.motion.key("ShiftLeft", true), false);
  for (const f of [forward, diagonal, boost, leftShift]) run(f, 60, 60);
  const origin = new THREE.Vector3(0, 0, 3), distance = forward.camera.position.distanceTo(origin);
  close(diagonal.camera.position.distanceTo(origin), distance);
  close(boost.camera.position.distanceTo(origin), distance * 4);
  close(leftShift.camera.position.distanceTo(origin), distance);
});

test("a mouse turn leaves accumulated momentum in world space", () => {
  const f = flight(); f.motion.key("ArrowUp", true); run(f, 60, 60);
  f.motion.key("ArrowUp", false);
  const position = f.camera.position.clone();
  f.motion.look(Math.PI / 2 / 0.0025, 0); f.motion.step(0);
  f.motion.step(0.1);
  close(f.camera.position.x, position.x);
  assert.ok(f.camera.position.z < position.z);
  close(f.camera.position.distanceTo(f.target), 3);
  close(f.camera.quaternion.length(), 1);
});

test("vertical thrust follows camera roll, and look crosses the poles without an Euler clamp", () => {
  const f = flight(); f.motion.key("KeyQ", true); run(f, 60, 60);
  f.motion.key("KeyQ", false); f.motion.key("PageUp", true); run(f, 60, 60);
  assert.ok(f.camera.position.x < -0.7);
  assert.ok(f.camera.up.x < -0.9);
  f.motion.look(0, Math.PI / 0.0025); f.motion.step(0);
  const forward = f.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(forward.z > 0.99);
  close(f.camera.quaternion.length(), 1);
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

function lifecycle({ pending = false, denied = false } = {}) {
  const f = flight(), owner = new EventTarget(), win = new EventTarget();
  owner.defaultView = win; owner.hidden = false; owner.pointerLockElement = null;
  const states = [], errors = [];
  let permitted = true, renders = 0, exits = 0, activations = 0, deactivations = 0;
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
    getTarget: () => f.target, canStart: () => permitted, requestRender: () => renders++,
    onStateChange: state => states.push(state), onError: error => errors.push(error),
    onActivate: () => activations++, onDeactivate: () => deactivations++ });
  return { ...f, control, states, errors, owner, win, element, grant, event,
    permit: value => { permitted = value; }, counts: () => ({ renders, exits, activations, deactivations }) };
}

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
    f.event("keydown", { code: "KeyQ", key: "й" });
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

test("modifier shortcuts release thrust and Q/E use physical codes in every layout", () => {
  const f = lifecycle(); f.control.start(); f.control.update(0);
  f.event("keydown", { code: "KeyQ", key: "й" }); f.control.update(100); f.control.update(200);
  assert.ok(f.camera.up.x < 0); f.event("keyup", { code: "KeyQ" });
  f.event("keydown", { code: "ArrowUp", ctrlKey: true });
  const position = f.camera.position.clone(); f.control.update(300);
  assert.deepEqual(f.camera.position, position);
  f.control.dispose();
});
