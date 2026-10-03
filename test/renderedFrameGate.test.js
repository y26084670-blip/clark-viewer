import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera } from "../src/services/movie/renderedFrameGate.js";

test("movie readiness follows rendered publication identity rather than matching time numbers", async () => {
  const gate = createRenderedFrameGate();
  const expected = { request: { time: 2 } }, other = { request: { time: 2 } };
  let resolved = false;
  const pending = gate.wait(expected).then(value => { resolved = true; return value; });
  gate.rendered(other);
  await Promise.resolve();
  assert.equal(resolved, false);
  gate.rendered(expected);
  assert.equal(await pending, expected);
  assert.equal(await gate.wait(expected), expected);
  gate.close();
});

test("context loss and unmount reject pending movie frames; successful renders clear recoverable failure", async () => {
  const gate = createRenderedFrameGate(), first = {}, second = {};
  const pending = gate.wait(first);
  const failed = assert.rejects(pending, /WebGL потерян/);
  gate.fail(new Error("WebGL потерян"));
  await failed;
  await assert.rejects(gate.wait(first), /WebGL потерян/);
  gate.rendered(second);
  assert.equal(await gate.wait(second), second);
  const closing = assert.rejects(gate.wait(first), /закрыто/);
  gate.close(); await closing;
  gate.rendered(first);
  await assert.rejects(gate.wait(first), /закрыто/);
});

test("aborting a waiter leaves the renderer and other frame waiters usable", async () => {
  const gate = createRenderedFrameGate(), key = {}, controller = new AbortController();
  const aborted = assert.rejects(gate.wait(key, { signal: controller.signal }), { name: "AbortError" });
  const live = gate.wait(key);
  controller.abort(); await aborted;
  gate.rendered(key); assert.equal(await live, key);
  await assert.rejects(gate.wait(key, { signal: controller.signal }), { name: "AbortError" });
  gate.close();
});

test("capture redraws and copies synchronously before the WebGL buffer can be discarded", async () => {
  const gate = createRenderedFrameGate(), key = {}, order = [];
  gate.rendered(key);
  let buffer = null;
  const result = captureRenderedMovieFrame(gate, key, () => {
    order.push("render"); buffer = new Uint8ClampedArray([7, 8, 9, 255]);
    queueMicrotask(() => { order.push("discard"); buffer = null; });
    gate.rendered(key);
  }, () => { order.push("copy"); return { data: buffer.slice(), width: 1, height: 1 }; });
  assert.deepEqual(order, ["render", "copy"]);
  assert.deepEqual(Array.from(result.data), [7, 8, 9, 255]);
  await Promise.resolve(); assert.deepEqual(order, ["render", "copy", "discard"]);
});

test("capture rejects stale or failed frames instead of copying a wrong movie step", () => {
  const gate = createRenderedFrameGate(), key = {}, replacement = {};
  let copies = 0;
  assert.throws(() => captureRenderedMovieFrame(gate, key, () => {}, () => copies++), /не отрисован/);
  gate.rendered(key);
  assert.throws(() => captureRenderedMovieFrame(gate, key, () => gate.rendered(replacement), () => copies++), /изменился/);
  gate.rendered(key);
  assert.throws(() => captureRenderedMovieFrame(gate, key, () => gate.fail(new Error("GPU")), () => copies++), /изменился/);
  assert.equal(copies, 0);
});

for (const orthographic of [true, false]) test(`${orthographic ? "orthographic" : "perspective"} camera restore retains zoom, direction, target and prior controls state`, () => {
  const camera = orthographic ? new THREE.OrthographicCamera(-10, 10, 6, -6, .01, 300)
    : new THREE.PerspectiveCamera(35, 1.5, .1, 500);
  camera.position.set(12, 13, 14); camera.up.set(0, 0, 1); camera.zoom = 2.7; camera.updateProjectionMatrix();
  const controls = { enabled: false, target: new THREE.Vector3(1, 2, 3), update() { camera.lookAt(this.target); } };
  controls.update();
  const original = camera.clone(), target = controls.target.clone();
  const snapshot = snapshotMovieCamera(camera, controls);
  assert.equal(controls.enabled, false);
  camera.position.set(100, 200, 300); camera.up.set(0, 1, 0); camera.zoom = .5;
  controls.target.set(-1, -2, -3); controls.enabled = true;
  restoreMovieCamera(camera, controls, snapshot);
  assert.deepEqual(camera.position.toArray(), original.position.toArray());
  assert.deepEqual(camera.up.toArray(), original.up.toArray());
  assert.deepEqual(camera.projectionMatrix.elements, original.projectionMatrix.elements);
  assert.ok(camera.quaternion.angleTo(original.quaternion) < 1e-7);
  assert.equal(camera.zoom, original.zoom);
  assert.deepEqual(controls.target.toArray(), target.toArray());
  assert.equal(controls.enabled, false);
});
