import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  GEOMETRY_AXIS_ROTATION,
  geometryAxisRotationFromKeyboardEvent,
  geometryOriginAxisRotationFromKeyboardEvent,
  rotateGeometryCameraAroundAxis,
  snapshotGeometryCamera,
  restoreGeometryCamera,
} from "../src/services/visualization/geometryCameraView.js";

const key = (code, extras = {}) => ({
  code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
  defaultPrevented: false, isComposing: false, target: { tagName: "DIV" }, ...extras,
});

test("numeric camera state restores pose, roll, scale and projection at a new canvas aspect", () => {
  for (const projection of ["perspective", "orthographic"]) {
    const camera = projection === "orthographic"
      ? new THREE.OrthographicCamera(-12, 12, 6, -6, 0.001, 1000)
      : new THREE.PerspectiveCamera(45, 2, 0.001, 1000);
    camera.position.set(9, -8, 7); camera.rotateY(0.6); camera.rotateX(-0.8); camera.rotateZ(1.1);
    camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion); camera.zoom = 3.7;
    const target = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 4);
    const state = snapshotGeometryCamera(camera, { target }, projection);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state, "cache contains only numeric values");
    const restored = projection === "orthographic"
      ? new THREE.OrthographicCamera(-3, 3, 1, -1)
      : new THREE.PerspectiveCamera(60, 3);
    const controls = { target: new THREE.Vector3() };
    assert.equal(restoreGeometryCamera(restored, controls, state), true);
    assert.deepEqual(restored.position, camera.position); assert.deepEqual(restored.up, camera.up);
    assert.ok(restored.quaternion.angleTo(camera.quaternion) < 1e-7);
    assert.equal(restored.zoom, 3.7); assert.equal(restored.near, 0.001); assert.equal(restored.far, 1000);
    assert.deepEqual(controls.target, target);
    if (projection === "orthographic") {
      assert.equal(restored.top, 6); assert.equal(restored.bottom, -6);
      assert.equal(restored.right, 18); assert.equal(restored.left, -18);
    } else { assert.equal(restored.fov, 45); assert.equal(restored.aspect, 3); }
    assert.equal(restoreGeometryCamera(restored, controls, { ...state, zoom: NaN }), false);
    assert.equal(restoreGeometryCamera(restored, controls, { ...state, target: [1, Infinity, 3] }), false);
    assert.equal(restoreGeometryCamera(restored, controls, { ...state, projection: projection === "orthographic" ? "perspective" : "orthographic" }), false);
  }
});

test("Alt+X/Y/Z selects a fixed world rotation axis only on valid targets", () => {
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX")), GEOMETRY_AXIS_ROTATION.X);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyY")), GEOMETRY_AXIS_ROTATION.Y);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyZ")), GEOMETRY_AXIS_ROTATION.Z);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { altKey: false })), null);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { ctrlKey: true })), null);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { target: { tagName: "INPUT", type: "text" } })), null);
  assert.equal(geometryOriginAxisRotationFromKeyboardEvent(key("KeyX", { altKey: false, shiftKey: true })), GEOMETRY_AXIS_ROTATION.X);
  assert.equal(geometryOriginAxisRotationFromKeyboardEvent(key("KeyY", { altKey: false, shiftKey: true })), GEOMETRY_AXIS_ROTATION.Y);
  assert.equal(geometryOriginAxisRotationFromKeyboardEvent(key("KeyZ", { altKey: false, shiftKey: true })), GEOMETRY_AXIS_ROTATION.Z);
  assert.equal(geometryOriginAxisRotationFromKeyboardEvent(key("KeyX", { shiftKey: true })), null);
});

test("fixed-axis rotation preserves target distance and rotates camera/up around the selected world axis", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 4, 0);
  camera.up.set(0, 0, 1);
  const target = new THREE.Vector3(0, 0, 0);
  let updates = 0;
  const controls = { target, update() { updates++; } };
  const distance = camera.position.distanceTo(target);
  assert.equal(rotateGeometryCameraAroundAxis(camera, controls, "x", Math.PI / 2), true);
  assert.ok(camera.position.distanceTo(target) - distance < 1e-12);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(0, 0, 4)) < 1e-12);
  assert.ok(camera.up.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-12);
  assert.equal(updates, 1);
  assert.equal(rotateGeometryCameraAroundAxis(camera, controls, "bad", 1), false);
});


test("origin-axis rotation turns camera and view target together around world origin", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2, 4, 0);
  camera.up.set(0, 0, 1);
  const controls = { target: new THREE.Vector3(2, 0, 0), update() {} };
  const relative = camera.position.clone().sub(controls.target);
  const pivot = new THREE.Vector3(0, 0, 0);
  assert.equal(rotateGeometryCameraAroundAxis(camera, controls, "z", Math.PI / 2, {
    pivot, rotateTarget: true,
  }), true);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-4, 2, 0)) < 1e-12);
  assert.ok(controls.target.distanceTo(new THREE.Vector3(0, 2, 0)) < 1e-12);
  assert.ok(camera.position.clone().sub(controls.target)
    .distanceTo(relative.applyAxisAngle(new THREE.Vector3(0,0,1), Math.PI / 2)) < 1e-12);
});


test("pre-flight view snapshots stay independent and restore both camera types after motion", () => {
  for(const projection of ["perspective","orthographic"]) {
    const camera=projection==="orthographic"?new THREE.OrthographicCamera(-4,4,2,-2,.01,100):new THREE.PerspectiveCamera(50,2,.01,100);
    camera.position.set(3,-2,7);camera.zoom=2.3;camera.rotateY(.4);camera.rotateZ(.7);
    camera.up.set(0,1,0).applyQuaternion(camera.quaternion);
    const controls={target:camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()),5)};
    const saved=snapshotGeometryCamera(camera,controls,projection),expected=structuredClone(saved);
    camera.position.set(200,100,-300);camera.zoom=.2;camera.rotateX(1);controls.target.set(1,2,3);
    assert.deepEqual(saved,expected);
    assert.equal(restoreGeometryCamera(camera,controls,saved),true);
    const restored=snapshotGeometryCamera(camera,controls,projection);
    for(const key of ["position","up","target"])assert.deepEqual(restored[key],saved[key]);
    assert.equal(restored.zoom,saved.zoom);assert.equal(restored.projection,saved.projection);
    assert.ok(camera.quaternion.angleTo(new THREE.Quaternion().fromArray(saved.quaternion))<1e-7);
  }
});
