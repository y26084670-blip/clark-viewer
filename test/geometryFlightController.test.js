import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createGeometryFlightMotion, createGeometryFlightController } from "../src/services/visualization/geometryFlightController.js";

function flight({ orbitTarget } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 3);
  const target = new THREE.Vector3();
  const getOrbitTarget = () => orbitTarget === undefined
    ? { point: camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 3).toArray() } : orbitTarget;
  return { camera, target, getOrbitTarget, motion: createGeometryFlightMotion(THREE, { camera, target, speed: 1, getOrbitTarget }) };
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

test("linear motion uses only forward/backward; only right Shift boosts its speed", () => {
  const forward=flight(),boost=flight(),leftShift=flight();
  for(const f of [forward,boost,leftShift])f.motion.key("ArrowUp",true);
  boost.motion.key("ShiftRight",true);assert.equal(leftShift.motion.key("ShiftLeft",true),false);
  for(const f of [forward,boost,leftShift])run(f,60,60);
  const distance=3-forward.camera.position.z;
  close(3-boost.camera.position.z,distance*4);close(3-leftShift.camera.position.z,distance);
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
  const f=flight();f.motion.key("KeyQ",true);run(f,60,60);f.motion.key("KeyQ",false);
  const origin=f.camera.position.clone();f.motion.key("Enter",true);run(f,60,60);
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

function lifecycle({ pending = false, denied = false, approachTarget = null } = {}) {
  const f = flight(), owner = new EventTarget(), win = new EventTarget();
  owner.defaultView = win; owner.hidden = false; owner.pointerLockElement = null;
  const states = [], errors = [];
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
    onStateChange: state => states.push(state), onError: error => errors.push(error),
    onActivate: () => activations++, onDeactivate: reason => { deactivations++; stopReasons.push(reason); } });
  return { ...f, control, states, errors, owner, win, element, grant, event, stopReasons,
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

test("right Ctrl orbits down and composes with forward motion and zoom without browser shortcuts", () => {
  const f = lifecycle(); f.control.start(); f.control.update(0);
  assert.equal(f.event("keydown", { code: "ControlRight", ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.event("keydown", { code: "ArrowUp", ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.event("keydown", { code: "Equal", ctrlKey: true, shiftKey: true }).defaultPrevented, true);
  f.control.update(100); f.control.update(200);
  assert.ok(f.camera.position.y < 0); assert.ok(f.camera.position.z < 3); assert.ok(f.camera.zoom > 1);
  f.event("keyup", { code: "ControlRight", ctrlKey: false });
  f.event("keyup", { code: "ArrowUp" }); f.event("keyup", { code: "Equal" });
  f.control.dispose();
  const up = flight(); up.motion.key("Enter", true); run(up, 60, 60); assert.ok(up.camera.position.y > 0.7);
  assert.equal(up.motion.key("PageUp", true), false); assert.equal(up.motion.key("PageDown", true), false);
});

test("zoom is reversible and frame-rate independent in both projections without moving the camera", () => {
  for (const Camera of [THREE.PerspectiveCamera, THREE.OrthographicCamera]) {
    const zooms = [];
    for (const fps of [30, 60, 144]) {
      const camera = new Camera(), target = new THREE.Vector3(0, 0, -3);
      const f = { motion: createGeometryFlightMotion(THREE, { camera, target }) };
      const position = camera.position.clone(), quaternion = camera.quaternion.clone();
      f.motion.key("NumpadAdd", true); run(f, fps, fps); f.motion.key("NumpadAdd", false);
      zooms.push(camera.zoom); assert.ok(camera.zoom > 3);
      assert.deepEqual(camera.position, position); close(camera.quaternion.angleTo(quaternion), 0);
      f.motion.key("Minus", true); run(f, fps, fps); f.motion.key("Minus", false);
      close(camera.zoom, 1); assert.equal(f.motion.needsFrame, false);
      // A short tap survives key release before the next render.
      f.motion.key("Equal", true); f.motion.key("Equal", false); f.motion.step(0);
      close(camera.zoom, 1.08);
      f.motion.key("NumpadSubtract", true); f.motion.key("NumpadSubtract", false); f.motion.step(0);
      close(camera.zoom, 1);
    }
    close(Math.max(...zooms), Math.min(...zooms));
  }
});

test("opposite zoom/vertical keys cancel and zoom bounds stop an idle RAF", () => {
  const f = flight();
  for (const code of ["Equal", "Minus", "Enter", "ControlRight"]) f.motion.key(code, true);
  run(f, 60, 60); close(f.camera.zoom, 1); close(f.camera.position.y, 0);
  assert.equal(f.motion.needsFrame, false);
  f.motion.key("Enter", false); f.motion.key("ControlRight", false);
  f.motion.step(0); assert.equal(f.motion.orbiting, false, "release an idle pivot even when RAF has already stopped");
  const next = f.camera.position.clone().addScaledVector(f.camera.getWorldDirection(new THREE.Vector3()), 3).toArray();
  f.motion.key("ArrowRight", true); assert.deepEqual(f.motion.orbitTarget.point, next);
  f.motion.clear(); f.camera.zoom = 100; f.motion.key("Equal", true); f.motion.step(0);
  assert.equal(f.camera.zoom, 100); assert.equal(f.motion.needsFrame, false);
  f.motion.clear(); f.camera.zoom = 0.02; f.motion.key("Minus", true); f.motion.step(0);
  assert.equal(f.camera.zoom, 0.02); assert.equal(f.motion.needsFrame, false);
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
    if (input === "key") f.motion.key("Enter", true);
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
  for(const fps of [30,60,144])for(const [code,axis,sign] of [["ArrowRight","x",1],["ArrowLeft","x",-1],["Enter","y",1],["ControlRight","y",-1]]) {
    const f=flight();f.motion.key(code,true);run(f,2*fps,fps);
    close(f.camera.position[axis],sign*3*Math.sin(angle));close(f.camera.position.z,3*Math.cos(angle));close(f.camera.position.length(),3);
    close(f.camera.getWorldDirection(new THREE.Vector3()).dot(f.camera.position.clone().normalize().negate()),1);
    assert.deepEqual(f.motion.orbitTarget.point,[0,0,0]);
    f.motion.key(code,false);run(f,fps,fps);close(f.camera.position[axis],sign*3*Math.sin(angle+coast));
    assert.equal(f.motion.orbiting,true,"the centre must survive the inertial tail");
    run(f,5*fps,fps);assert.equal(f.motion.orbiting,false);assert.equal(f.motion.needsFrame,false);close(f.camera.position.length(),3);
  }
});

test("diagonal orbit is normalized and right Shift accelerates rotation fourfold", () => {
  for(const fps of [30,60,144]) {
    const angle=Math.PI/6*(1-.25*(1-Math.exp(-4)));
    for(const boost of [false,true]) {
      const f=flight();f.motion.key("ArrowRight",true);f.motion.key("Enter",true);if(boost)f.motion.key("ShiftRight",true);
      run(f,fps,fps);close(f.camera.position.length(),3);close(f.camera.position.z,3*Math.cos(angle*(boost?4:1)));
      close(f.camera.position.x,f.camera.position.y);assert.ok(f.camera.position.x>0);close(f.camera.quaternion.length(),1);
    }
  }
});

test("a gesture keeps one pivot through repeats/coasting; mouse cancels it until the held key is released", () => {
  const f=flight();let calls=0;const points=[[0,0,0],[2,1,0]];
  const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>({point:points[Math.min(calls++,1)]})});
  motion.key("ArrowRight",true);for(let i=0;i<60;i++)motion.step(1/60);motion.key("ArrowRight",true);
  assert.equal(calls,1);motion.key("ArrowRight",false);motion.step(.1);assert.deepEqual(motion.orbitTarget.point,points[0]);
  motion.key("Enter",true);assert.equal(calls,1);motion.look(20,0);assert.equal(motion.orbiting,false);
  motion.key("Enter",true);assert.equal(calls,1);assert.equal(motion.orbiting,false);
  motion.key("Enter",false);motion.key("Enter",true);assert.equal(calls,2);assert.deepEqual(motion.orbitTarget.point,points[1]);
  points[1][0]=99;assert.equal(motion.orbitTarget.point[0],2,"retain a numeric copy of the selected pivot");
});

test("an empty reticle never invents a centre or keeps RAF running; repeats cannot retry a missed gesture", () => {
  for(const code of ["ArrowLeft","ArrowRight","Enter","ControlRight"]) {
    const f=flight();let calls=0,available=false;
    const motion=createGeometryFlightMotion(THREE,{camera:f.camera,target:f.target,getOrbitTarget:()=>{calls++;return available?{point:[0,0,0]}:null;}});
    const before=f.camera.position.clone();assert.equal(motion.key(code,true),true);motion.step(.1);assert.deepEqual(f.camera.position,before);
    assert.equal(motion.needsFrame,false);available=true;motion.key(code,true);assert.equal(calls,1);assert.equal(motion.orbiting,false);
    motion.key(code,false);motion.key(code,true);assert.equal(calls,2);assert.equal(motion.orbiting,true);
  }
});

test("orbit can cross both poles, adjusts its radius with forward motion, and stops at the centre without flipping", () => {
  const f=flight();f.motion.key("Enter",true);run(f,600,60);close(f.camera.position.length(),3);close(f.camera.quaternion.length(),1);
  const pivot=f.motion.orbitTarget.point,prior=f.camera.position.distanceTo(new THREE.Vector3().fromArray(pivot));
  f.motion.key("ArrowUp",true);run(f,60,60);assert.ok(f.camera.position.distanceTo(new THREE.Vector3().fromArray(pivot))<prior);
  const direction=f.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(direction.dot(new THREE.Vector3().fromArray(pivot).sub(f.camera.position).normalize())>.999999);
  f.motion.key("Enter",false);run(f,240,60);assert.equal(f.motion.orbiting,false);assert.ok(f.camera.position.toArray().every(Number.isFinite));
});
