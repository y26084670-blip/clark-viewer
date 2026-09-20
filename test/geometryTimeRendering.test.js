import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import * as THREE from "three";

// Load the production JSX module, including its real Three.js update functions.
// These tests exercise resource identity and numerical behavior without WebGL.
const server = await createServer({
  configFile: false,
  plugins: [solid({ssr: true})],
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
after(() => server.close());
const { createPrescribedSourceVectors, captureMotionBuffer, updateMotionBuffer, updateResultPoints } =
  await server.ssrLoadModule("/src/components/geometry/ThreeGeometryViewport.jsx");

const source = { recordIndex: 0, schemaId: "elements" };
const instance = { ls: 0, as: 0, ps: 0, mirrorX: false, mirrorY: false };
const accepted = new Set(["0:0:0:0:0:0"]);
const vector = (factor, kind = "current") => ({
  source, instance, kind, origin: [1, 2, 3], vector: [factor, 0, 0],
  magnitude: Math.abs(factor), characteristicSize: 1,
});
function update(root, style, values) {
  return createPrescribedSourceVectors(THREE, values, accepted, 100, style,
    {current: 1, magnetization: 1}, {current: 1, magnetization: 1}, undefined, root);
}

for (const style of ["thin", "solid"]) {
  test(`${style}: amplitude, sign and zero preserve objects and GPU allocations`, () => {
    const root = update(null, style, [vector(1), vector(1, "magnetization")]);
    const children = [...root.children];
    const resources = children.map(c => [c.geometry, c.material,
      style === "thin" ? c.geometry.getAttribute("position") : c.instanceMatrix]);
    let disposals = 0;
    for (const child of children) {
      child.addEventListener("dispose", () => disposals++);
      child.geometry.addEventListener("dispose", () => disposals++);
      child.material.addEventListener("dispose", () => disposals++);
    }
    for (const factor of [0.3, 0, -0.5, 1, 0, -1]) {
      assert.equal(update(root, style, [vector(factor), vector(factor, "magnetization")]), root);
      assert.deepEqual(root.children, children);
      children.forEach((child, i) => {
        assert.equal(child.geometry, resources[i][0]);
        assert.equal(child.material, resources[i][1]);
        assert.equal(style === "thin" ? child.geometry.getAttribute("position") : child.instanceMatrix, resources[i][2]);
        assert.equal(child.visible, factor !== 0);
      });
      if (style === "thin" && factor !== 0) {
        const positions = children[0].geometry.getAttribute("position").array;
        assert.ok(Math.abs(positions[3] - (1 + factor * 0.7)) < 1e-6);
      }
      if (style === "solid" && factor !== 0) {
        const matrix = new THREE.Matrix4();
        children[0].getMatrixAt(0, matrix);
        const direction = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
        assert.ok(Math.abs(direction.x - Math.sign(factor)) < 1e-6);
        assert.equal(children[0].count, 1);
      }
    }
    assert.equal(disposals, 0);
  });
}

test("capacity growth frees superseded allocations; shrinking reuses capacity", () => {
  const thin = update(null, "thin", [vector(1)]);
  const line = thin.children[0];
  let freed = 0;
  line.geometry.addEventListener("dispose", () => freed++);
  update(thin, "thin", Array.from({length: 5}, () => vector(1)));
  assert.equal(thin.children[0], line);
  assert.equal(freed, 1);
  const large = line.geometry;
  update(thin, "thin", [vector(1)]);
  assert.equal(line.geometry, large);
  assert.equal(line.geometry.drawRange.count, 2);

  const solid = update(null, "solid", [vector(1)]);
  const oldMesh = solid.children[0];
  let meshesFreed = 0;
  oldMesh.addEventListener("dispose", () => meshesFreed++);
  update(solid, "solid", Array.from({length: 3}, () => vector(1)));
  assert.equal(meshesFreed, 1);
  assert.notEqual(solid.children[0], oldMesh);
  assert.equal(solid.children[0].geometry, oldMesh.geometry);
  assert.equal(solid.children[0].material, oldMesh.material);
  const expanded = solid.children[0];
  update(solid, "solid", []);
  update(solid, "solid", [vector(-1)]);
  assert.equal(solid.children[0], expanded);
  assert.equal(expanded.count, 1);
});

test("changing arrow style releases the previous style exactly once", () => {
  const root = update(null, "thin", [vector(1)]);
  let freed = 0;
  const old = root.children[0];
  old.geometry.addEventListener("dispose", () => freed++);
  old.material.addEventListener("dispose", () => freed++);
  update(root, "solid", [vector(1)]);
  assert.equal(freed, 2);
  assert.equal(old.parent, null);
  assert.equal(root.children.length, 2);
  update(root, "solid", [vector(-1)]);
  assert.equal(freed, 2);
});

test("motion updates retained positions and picking coordinates without accumulated drift", () => {
  const initial = new THREE.Matrix4().makeTranslation(10, 20, 30);
  const reference = [11, 22, 33, 12, 23, 34];
  const positions = new Float64Array(reference);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(reference, 3));
  const object = new THREE.LineSegments(geometry);
  const attribute = geometry.getAttribute("position");
  const buffer = captureMotionBuffer(THREE, object, [{source, start: 0, end: 2,
    instances: [{...instance, matrix: initial.elements}]}], positions);
  for (let step = 0; step < 200; step++) {
    const matrix = new THREE.Matrix4().makeRotationZ(step * 0.031);
    matrix.setPosition(step / 7, -step / 9, 5);
    updateMotionBuffer(THREE, buffer, () => [{...instance, matrix: matrix.elements}]);
    assert.equal(object.geometry, geometry);
    assert.equal(geometry.getAttribute("position"), attribute);
    for (let i = 0; i < 2; i++) {
      const expected = new THREE.Vector3(1 + i, 2 + i, 3 + i).applyMatrix4(matrix);
      assert.ok(expected.distanceTo(new THREE.Vector3().fromArray(positions, i * 3)) < 1e-12);
      assert.ok(expected.distanceTo(new THREE.Vector3().fromBufferAttribute(attribute, i)) < 2e-6);
    }
  }
  updateMotionBuffer(THREE, buffer, () => [{...instance, matrix: initial.elements}]);
  assert.deepEqual(Array.from(positions), reference);
  assert.deepEqual(Array.from(attribute.array), reference);
});

for (const scalar of [false, true]) {
  test(`${scalar ? "scalar" : "vector"} result nodes reuse buffers and refresh picking metadata`, () => {
    const previousDocument = globalThis.document;
    globalThis.document = {createElement: () => ({getContext: () => ({beginPath(){},arc(){},fill(){}})})};
    try {
      const options = {scalar, minimum:0, maximum:10, color:0xff0000};
      const make = (i) => ({origin:[i,2*i,3*i],value:i,vector:[i,0,0]});
      const root = updateResultPoints(THREE, null, [make(0),make(1)], options);
      const geometry=root.geometry, material=root.material, texture=material.map;
      const position=geometry.getAttribute("position"), color=geometry.getAttribute("color");
      let disposals=0;
      geometry.addEventListener("dispose",()=>disposals++);
      material.addEventListener("dispose",()=>disposals++);
      texture?.addEventListener("dispose",()=>disposals++);
      for (const values of [[make(3)],[],[make(4),make(5)]]) {
        assert.equal(updateResultPoints(THREE,root,values,options),root);
        assert.equal(root.geometry,geometry); assert.equal(root.material,material); assert.equal(material.map,texture);
        assert.equal(geometry.getAttribute("position"),position); assert.equal(geometry.getAttribute("color"),color);
        assert.equal(geometry.drawRange.count,values.length);
        assert.equal(root.visible,values.length>0);
        assert.equal(root.userData[scalar ? "resultScalars" : "resultVectors"],values);
        if(values.length) assert.deepEqual(Array.from(position.array.slice(0,3)),values[0].origin);
      }
      assert.equal(disposals,0);
      updateResultPoints(THREE,root,Array.from({length:5},(_,i)=>make(i)),options);
      assert.equal(disposals,1); assert.equal(root.material,material); assert.equal(material.map,texture);
    } finally {globalThis.document=previousDocument;}
  });
}
