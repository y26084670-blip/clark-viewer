import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  GEOMETRY_AXIS_ROTATION,
  geometryAxisRotationFromKeyboardEvent,
  rotateGeometryCameraAroundAxis,
} from "../src/services/visualization/geometryCameraView.js";

const key = (code, extras = {}) => ({
  code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
  defaultPrevented: false, isComposing: false, target: { tagName: "DIV" }, ...extras,
});

test("Alt+X/Y/Z selects a fixed world rotation axis only on valid targets", () => {
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX")), GEOMETRY_AXIS_ROTATION.X);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyY")), GEOMETRY_AXIS_ROTATION.Y);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyZ")), GEOMETRY_AXIS_ROTATION.Z);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { altKey: false })), null);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { ctrlKey: true })), null);
  assert.equal(geometryAxisRotationFromKeyboardEvent(key("KeyX", { target: { tagName: "INPUT", type: "text" } })), null);
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
