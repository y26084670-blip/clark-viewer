import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createViewCube, viewCubeRayDirection, orientViewCubeCamera, syncViewCubeCamera,
  installViewCubeControls } from "../src/services/visualization/geometryViewCube.js";

const directions = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
  if (x || y || z) directions.push([x, y, z]);
}
function cube() {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
  }) }) };
  try { return createViewCube(THREE); } finally { globalThis.document = previous; }
}
function dispose(root) {
  root.traverse(object => {
    object.geometry?.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material?.map?.dispose(); material?.dispose();
    }
  });
}

test("all 26 ViewCube directions preserve target, distance, zoom and projection", () => {
  for (const camera of [new THREE.PerspectiveCamera(40, 2, .1, 1000), new THREE.OrthographicCamera(-4, 4, 2, -2, .1, 1000)]) {
    const controls = { target: new THREE.Vector3(11, -7, 4) };
    camera.position.set(21, 3, 14); camera.zoom = 2.5; camera.updateProjectionMatrix();
    const distance = camera.position.distanceTo(controls.target), projection = camera.projectionMatrix.clone();
    for (const direction of directions) {
      assert.equal(orientViewCubeCamera(camera, controls, direction), true);
      const offset = camera.position.clone().sub(controls.target);
      assert.ok(Math.abs(offset.length() - distance) < 1e-10);
      assert.ok(offset.normalize().distanceTo(new THREE.Vector3(...direction).normalize()) < 1e-10);
      assert.ok(camera.getWorldDirection(new THREE.Vector3()).add(offset).length() < 1e-10);
      assert.deepEqual(controls.target.toArray(), [11, -7, 4]);
      assert.equal(camera.zoom, 2.5); assert.deepEqual(camera.projectionMatrix.elements, projection.elements);
    }
    assert.equal(orientViewCubeCamera(camera, controls, [0, 0, 0]), false);
  }
});

test("ray picking distinguishes every face, edge and corner with the scene camera orientation", () => {
  const root = cube(), viewCamera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, .1, 20);
  const camera = new THREE.PerspectiveCamera(), controls = { target: new THREE.Vector3() };
  camera.position.set(5, 5, 5);
  const raycaster = new THREE.Raycaster(); root.updateMatrixWorld(true);
  try {
    for (const direction of directions) {
      orientViewCubeCamera(camera, controls, direction); syncViewCubeCamera(viewCamera, camera);
      assert.ok(viewCamera.quaternion.angleTo(camera.quaternion) < 1e-7);
      raycaster.setFromCamera(new THREE.Vector2(), viewCamera);
      assert.deepEqual(viewCubeRayDirection(THREE, raycaster.ray), direction);
    }
    camera.rotateZ(.7); camera.updateMatrixWorld(); syncViewCubeCamera(viewCamera, camera);
    assert.ok(viewCamera.quaternion.angleTo(camera.quaternion) < 1e-7, "camera roll is retained");
  } finally { dispose(root); }
});

test("cube click and drag are isolated from scene picking; disabled gestures and disposal are safe", () => {
  const handlers = new Map(), captures = new Set();
  const element = { style: {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 400 }),
    addEventListener: (type, handler, options) => { assert.equal(options.capture, true); handlers.set(type, handler); },
    removeEventListener: type => handlers.delete(type), setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const root = cube(), camera = new THREE.PerspectiveCamera(), controls = { target: new THREE.Vector3(2, 3, 4) };
  camera.position.set(12, 13, 14); camera.up.set(0, 0, 1); camera.lookAt(controls.target); camera.updateMatrixWorld();
  const viewCamera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, .1, 20);
  let enabled = true, changes = 0, hoverChanges = 0;
  const controller = installViewCubeControls({ THREE, element, root, viewCamera,
    getCamera: () => camera, getControls: () => controls, getSize: () => 120,
    canInteract: () => enabled, onChange: changed => { if (changed) changes++; else hoverChanges++; } });
  const fire = (type, extra = {}) => {
    const event = { type, pointerId: 1, button: 0, clientX: 78, clientY: 352,
      prevented: false, stopped: false, preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    handlers.get(type)(event); return event;
  };
  try {
    assert.ok(controller.hit({ clientX: 78, clientY: 352 }));
    fire("pointermove"); fire("pointermove");
    assert.equal(hoverChanges, 1, "unchanged hover does not render another frame");
    fire("pointermove", { clientX: 400, clientY: 100 });
    fire("pointermove", { clientX: 410, clientY: 100 });
    assert.equal(hoverChanges, 2, "scene mouse movement does not redraw the cube");
    assert.equal(fire("pointerdown").stopped, true); assert.equal(captures.size, 1);
    fire("pointerup"); assert.equal(changes, 1); assert.equal(captures.size, 0);
    const distance = camera.position.distanceTo(controls.target), before = camera.quaternion.clone();
    fire("pointerdown"); fire("pointermove", { clientX: 95, clientY: 370 }); fire("pointerup");
    assert.ok(camera.quaternion.angleTo(before) > .01);
    assert.ok(Math.abs(camera.position.distanceTo(controls.target) - distance) < 1e-10);
    assert.deepEqual(controls.target.toArray(), [2, 3, 4]);
    fire("pointerdown"); fire("pointermove", { clientX: 400, clientY: 100 });
    fire("pointerup", { clientX: 400, clientY: 100 });
    assert.equal(fire("click", { clientX: 400, clientY: 100 }).stopped, true,
      "releasing a cube drag over the scene must not select a result");
    fire("pointerdown", { clientX: 400, clientY: 100 });
    assert.equal(fire("click", { clientX: 400, clientY: 100 }).stopped, false);
    fire("pointerdown"); const beforeCancel = changes;
    fire("lostpointercapture"); assert.equal(changes, beforeCancel);
    assert.equal(captures.size, 0);
    enabled = false; const previous = camera.quaternion.clone(), count = changes;
    fire("pointerdown"); fire("pointermove"); fire("pointerup");
    assert.equal(changes, count); assert.ok(camera.quaternion.angleTo(previous) < 1e-7);
    assert.equal(fire("pointerdown", { clientX: 400, clientY: 100 }).stopped, false);
    assert.equal(fire("dblclick").stopped, true);
  } finally { controller.dispose(); dispose(root); }
  assert.equal(handlers.size, 0); assert.equal(captures.size, 0);
});
