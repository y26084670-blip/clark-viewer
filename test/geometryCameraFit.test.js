import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { fitCameraToVisibleObjects } from "../src/services/visualization/geometryCameraFit.js";

const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

function points(values) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(values.flat(), 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial());
}

function cameraSetup(projection = "orthographic", aspect = 2) {
  const camera = projection === "orthographic"
    ? new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 1000)
    : new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
  camera.position.set(0, 0, 10);
  const controls = {
    target: new THREE.Vector3(),
    update() { camera.lookAt(this.target); camera.updateMatrixWorld(); },
  };
  controls.update();
  return { camera, controls };
}

function boxVertices(width, height, depth) {
  return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z =>
    [x * width / 2, y * height / 2, z * depth / 2])));
}

function assertVisible(camera, values, padding = 1.08) {
  let largest = 0;
  for (const value of values) {
    const projected = new THREE.Vector3().fromArray(value).project(camera);
    assert.ok(Math.abs(projected.x) <= 1 / padding + 1e-7, `x clipped: ${projected.x}`);
    assert.ok(Math.abs(projected.y) <= 1 / padding + 1e-7, `y clipped: ${projected.y}`);
    assert.ok(Math.abs(projected.z) <= 1 + 1e-7, `depth clipped: ${projected.z}`);
    largest = Math.max(largest, Math.abs(projected.x), Math.abs(projected.y));
  }
  return largest;
}

test("Orthographic fit uses visible projection, ignoring a long depth", () => {
  const { camera, controls } = cameraSetup();
  const values = boxVertices(4, 2, 20000);
  assert.equal(fitCameraToVisibleObjects(THREE, camera, controls, [points(values)]), true);
  close(camera.top, 1.08);
  close(camera.right, 2.16);
  close(assertVisible(camera, values), 1 / 1.08);
  const distance = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).add(new THREE.Vector3(distance, 0, 0));
  controls.update();
  for (const value of values) {
    assert.ok(Math.abs(new THREE.Vector3().fromArray(value).project(camera).z) <= 1,
      "Orbit must not clip the object at the near/far planes");
  }
});

test("Oblique fit uses actual transformed vertices, not world bounding-box corners", () => {
  const { camera, controls } = cameraSetup();
  const object = points(boxVertices(4, 2, 2000));
  const backward = new THREE.Vector3(1, 1, 0).normalize();
  const right = new THREE.Vector3(-1, 1, 0).normalize();
  const up = new THREE.Vector3(0, 0, 1);
  object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, backward));
  object.position.set(100, 20, -30);
  camera.position.copy(backward).multiplyScalar(10);
  camera.up.copy(up);
  controls.update();
  const orientation = camera.quaternion.clone();
  fitCameraToVisibleObjects(THREE, camera, controls, [object]);
  close(camera.top, 1.08);
  close(camera.quaternion.angleTo(orientation), 0, 1e-7);
  assert.ok(controls.target.distanceTo(object.position) < 1e-8);
});

test("Narrow viewport and explicit padding determine the tight orthographic fit", () => {
  const { camera, controls } = cameraSetup("orthographic", 0.5);
  const values = boxVertices(4, 2, 6);
  fitCameraToVisibleObjects(THREE, camera, controls, [points(values)], { padding: 1.02 });
  close(camera.top, 4.08);
  close(assertVisible(camera, values, 1.02), 1 / 1.02);
});

test("Perspective fit contains different depths and fills at least one projected axis", () => {
  for (const aspect of [0.5, 2]) {
    const { camera, controls } = cameraSetup("perspective", aspect);
    const values = [[-5, -2, -100], [7, 6, 20], [3, -8, 0], [12, 1, 20]];
    const orientation = camera.quaternion.clone();
    fitCameraToVisibleObjects(THREE, camera, controls, [points(values)]);
    close(assertVisible(camera, values), 1 / 1.08);
    close(camera.quaternion.angleTo(orientation), 0, 1e-7);
    assert.ok(camera.near > 0 && camera.far > camera.near);
  }
});

test("Invisible geometry is excluded while result-only nodes and vector tips are framed", () => {
  const { camera, controls } = cameraSetup();
  const hiddenGeometry = new THREE.Group();
  hiddenGeometry.add(points(boxVertices(1000, 1000, 1000)));
  hiddenGeometry.visible = false;
  const helpers = new THREE.Group();
  const invisiblePoints = points(boxVertices(2000, 2000, 2000));
  invisiblePoints.material.visible = false;
  const values = [[20, 30, 5], [24, 32, 5]];
  const vector = new THREE.LineSegments(points(values).geometry, new THREE.LineBasicMaterial());
  helpers.add(invisiblePoints, points([values[0]]), vector);
  fitCameraToVisibleObjects(THREE, camera, controls, [hiddenGeometry, helpers]);
  assert.deepEqual(controls.target.toArray(), [22, 31, 5]);
  close(camera.top, 1.08);
  close(assertVisible(camera, values), 1 / 1.08);
});

test("Fit respects indexed draw ranges and instance transforms", () => {
  const { camera, controls } = cameraSetup();
  const object = points([[0, 0, 0], [2, 2, 0], [10000, 10000, 0]]);
  object.geometry.setIndex([0, 1, 2]);
  object.geometry.setDrawRange(0, 2);
  const mesh = new THREE.InstancedMesh(object.geometry, new THREE.MeshBasicMaterial(), 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(20, 0, 0));
  mesh.position.set(0, 50, 0);
  fitCameraToVisibleObjects(THREE, camera, controls, [mesh]);
  assert.deepEqual(controls.target.toArray(), [16, 51, 0]);
  close(camera.top, 3.24);
});

test("Point and edge-on line projections remain finite and inside clipping planes", () => {
  for (const projection of ["orthographic", "perspective"]) {
    for (const values of [[[3, 4, 5]], [[3, 4, -1000], [3, 4, 1000]]]) {
      const { camera, controls } = cameraSetup(projection);
      assert.equal(fitCameraToVisibleObjects(THREE, camera, controls, [points(values)]), true);
      assert.ok(camera.position.toArray().every(Number.isFinite));
      assert.ok(camera.near > 0 && camera.far > camera.near);
      assertVisible(camera, values);
    }
  }
});

test("Empty visible layers do not change the camera; projection changes can preserve a panned target", () => {
  const { camera, controls } = cameraSetup("perspective");
  const before = camera.position.clone();
  assert.equal(fitCameraToVisibleObjects(THREE, camera, controls, [new THREE.Group()]), false);
  assert.deepEqual(camera.position, before);
  const target = new THREE.Vector3(50, -40, 500);
  const values = boxVertices(4, 2, 6);
  fitCameraToVisibleObjects(THREE, camera, controls, [points(values)], { target });
  assert.deepEqual(controls.target, target);
  close(camera.position.clone().sub(target).normalize().z, 1);
  assertVisible(camera, values);
});
