import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { updateGraphScene, disposeGraphScene } from "../src/services/visualization/resultGraphRenderer.js";
import { createResultGraphReader } from "../src/services/results/resultGraphRequests.js";
import { calculateResultGraphs } from "../src/services/visualization/resultGraphField.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
const fixture = async () => {
  const f = graph3DTask({ mirror: 0 });
  const reader = createResultGraphReader({ processorFactory: () => ({ process: async input => calculateResultGraphs(input), close() {} }) });
  const { graphs, errors } = await reader.read({ task: f.task, time: 0, slices: [{ id: 1, recordIndex: 0, direction: 2, component: 0 }], regions: [0], quantities: { elements: "J", regions: "Bs" } });
  assert.deepEqual(errors, []); reader.close(); return { ...f, graphs, root: new THREE.Group() };
};
const surfaces = root => { const result = []; root.traverse(o => { if (o.name === "result-graph-surface") result.push(o); }); return result; };

test("surface graphs use lit RGB/palette meshes over white bases; size changes signed height without mutating field samples", async () => {
  const f = await fixture(); updateGraphScene(THREE, f.root, f.scene, f.graphs, { scale: 1 });
  const rgb = surfaces(f.root).filter(m => String(m.userData.graphId).startsWith("region:"));
  assert.deepEqual(rgb.slice(0,3).map(m => m.material.color.getHex()), [0xff0000,0x00ff00,0x0000ff]);
  assert.ok(rgb.every(m => m.material.isMeshStandardMaterial));
  const before = surfaces(f.root).find(m => m.userData.graphId === 1), data = before.userData.surface, values = data.values.slice();
  const z = before.geometry.attributes.position.getZ(0), base = data.positions[2];
  updateGraphScene(THREE, f.root, f.scene, f.graphs, { scale: 2 });
  const after = surfaces(f.root).find(m => m.userData.graphId === 1);
  assert.ok(Math.abs(after.geometry.attributes.position.getZ(0) - base - 2 * (z - base)) < 1e-5); assert.deepEqual(data.values, values);
  let bases = 0; f.root.traverse(o => { if (o.name === "result-graph-base") { assert.equal(o.material.color.getHex(), 0xffffff); assert.equal(o.material.depthWrite, false); bases++; } });
  assert.equal(bases, 6); disposeGraphScene(f.root);
});

test("symmetry filters preserve graph resources while hiding images; selection and preview do not read fields", async () => {
  const f = await fixture(); updateGraphScene(THREE, f.root, f.scene, f.graphs);
  const meshes = surfaces(f.root), count = f.reads.length;
  updateGraphScene(THREE, f.root, f.scene, f.graphs, { filters: { symmetry: { mirror: false, periodic: false } }, selected: { recordIndex: 0 }, preview: { recordIndex: 0, direction: 1 } });
  assert.equal(surfaces(f.root)[0], meshes[0]); assert.equal(surfaces(f.root).filter(m => m.parent.visible).length, 4);
  assert.ok(f.root.getObjectByName("graph-selected-element")); assert.ok(f.root.getObjectByName("graph-slice-preview")); assert.equal(f.reads.length, count);
  disposeGraphScene(f.root);
});

test("replacing and removing surface plots disposes geometry and material resources", async () => {
  const f = await fixture(); updateGraphScene(THREE, f.root, f.scene, f.graphs);
  let expected = 0, disposed = 0;
  f.root.traverse(o => { for (const resource of [o.geometry, o.material].filter(Boolean)) { expected++; resource.addEventListener("dispose", () => disposed++); } });
  updateGraphScene(THREE, f.root, f.scene, [], {}); assert.equal(f.root.children.length, 0); assert.equal(disposed, expected);
});
