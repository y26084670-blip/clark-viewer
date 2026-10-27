import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { graphContourSelection, graphContourSegments, graphSurfaceTargets, loadGraphContourRenderer } from "../src/services/visualization/resultGraphContours.js";
import { graphSurfaceIndices } from "../src/services/visualization/resultGraphField.js";
import { updateGraphScene, disposeGraphScene } from "../src/services/visualization/resultGraphRenderer.js";
import { installGraphContourInteraction } from "../src/services/visualization/resultGraphContourInteraction.js";

function surface(dimensions = [4, 3], extra = {}) {
  const positions = [], normals = [], values = [];
  for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) {
    const x = i / (dimensions[0] - 1), y = j / (dimensions[1] - 1);
    positions.push(x, y, 0); normals.push(0, 0, 1); values.push(2 * x - 3 * y);
  }
  return { key: "area:0", instance: { ls: 0, as: 0, ps: 0 }, component: 0, dimensions, nodeCounts: dimensions,
    positions: Float64Array.from(positions), normals: Float64Array.from(normals), values: Float64Array.from(values),
    indices: graphSurfaceIndices(dimensions, values), minimum: -3, maximum: 2, ...extra };
}
const hit = (s, uv = [.72, .4]) => ({ graphId: "region:0", surface: s, uv });
const raised = s => Float32Array.from(s.positions, (v, n) => n % 3 === 2 ? s.values[Math.floor(n / 3)] : v);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("two directions cut an affine surface through the nearest original node row", () => {
  const s = surface();
  for (const direction of [0, 1]) {
    const choice = graphContourSelection(hit(s), direction), segments = graphContourSegments(s, raised(s), choice);
    assert.equal(choice.index, direction === 0 ? 1 : 2);
    assert.ok(segments.length >= 12);
    for (let n = 0; n < segments.length; n += 3) {
      const [x, y, z] = segments.subarray(n, n + 3);
      close(direction === 0 ? y : x, direction === 0 ? .5 : 2 / 3); close(z, 2 * x - 3 * y);
    }
    const t = Array.from({ length: segments.length / 3 }, (_, n) => segments[n * 3 + direction]);
    close(Math.min(...t), 0); close(Math.max(...t), 1);
  }
});

test("slice snapping uses all EO centres rather than the bounded drawing grid, including one-cell axes", () => {
  const s = surface([4, 3], { nodeCounts: [200, 1], nodeLocation: "centres", directions: [0, 2] });
  const first = graphContourSelection(hit(s, [.9, .99]), 0), second = graphContourSelection(hit(s, [.833, .99]), 1);
  assert.equal(first.index, 0); assert.equal(second.index, 166);
  for (const [choice, fixed] of [[first, .5], [second, 166.5 / 200]]) {
    const data = graphContourSegments(s, raised(s), choice);
    for (let n = 0; n < data.length; n += 3) close(data[n + 1 - choice.direction], fixed);
  }
  assert.equal(graphContourSelection(hit(s, [-1, 2]), 1).index, 0);
  assert.equal(graphContourSelection(hit(s, [2, 0]), 1).index, 199);
  assert.equal(graphContourSelection(hit(s, [NaN, 0]), 1), null);
  assert.equal(graphContourSegments(s, raised(s), { direction: 1, index: 200 }).length, 0);
});

test("contours follow displayed triangle diagonals and leave missing triangles as holes", () => {
  const s = surface([3, 3]);
  s.values[4] = NaN; s.indices = graphSurfaceIndices(s.dimensions, s.values);
  const choice = graphContourSelection(hit(s, [.5, .5]), 0);
  assert.equal(graphContourSegments(s, raised(s), choice).length, 0);
  const nonplanar = surface([2, 2], { nodeCounts: [2, 2], nodeLocation: "centres" });
  nonplanar.values.set([0, 0, 0, 4]);
  const data = graphContourSegments(nonplanar, raised(nonplanar), { direction: 0, index: 0 });
  // At u=v=.25 the rendered diagonal has z=1; bilinear interpolation would give .25.
  assert.ok(Array.from({ length: data.length / 3 }, (_, n) => Array.from(data.subarray(n * 3, n * 3 + 3)))
    .some(([x, y, z]) => Math.abs(x - .25) < 1e-6 && Math.abs(y - .25) < 1e-6 && Math.abs(z - 1) < 1e-6));
});

test("selected and preview contours follow scale/time, stay on their own image, and release GPU resources", async () => {
  await loadGraphContourRenderer();
  const s = surface(), copy = { ...surface(), key: "area:copy", instance: { ls: 1, as: 0, ps: 0 } };
  const graph = { id: "region:0", kind: "region", components: 3, source: { schemaId: "regions", recordIndex: 0 }, referenceMaximum: 3, surfaces: [s, copy] };
  const root = new THREE.Group(), contour = graphContourSelection(hit(s), 0);
  const render = (g = graph, options = {}) => updateGraphScene(THREE, root, null, [g], { contour, resolution: [800, 600], ...options });
  render();
  const targets = graphSurfaceTargets(root); assert.equal(targets.length, 2);
  assert.ok(targets.every(m => m.geometry.attributes.uv.count === s.values.length));
  assert.ok(targets[0].getObjectByName("graph-contour")); assert.equal(targets[1].getObjectByName("graph-contour"), undefined);
  const points = () => root.getObjectByName("graph-contour-line").geometry.attributes.instanceStart;
  const z = points().getZ(0); render(graph, { scale: 2 }); close(points().getZ(0), (z - .01) * 2 + .01);
  const changed = { ...graph, surfaces: [{ ...s, minimum: s.minimum * 3, maximum: s.maximum * 3, values: Float64Array.from(s.values, v => v * 3) }, copy] };
  render(changed); close(points().getZ(0), (z - .01) * 3 + .01);
  render(graph, { contourPreview: { ...contour, direction: 1, index: 2 } });
  assert.ok(targets.length); const previews = []; root.traverse(o => { if (o.name === "graph-contour" && o.userData.preview) previews.push(o); }); assert.equal(previews.length, 1);
  render(); assert.equal(root.getObjectByName("graph-contour").userData.preview, false);
  render(graph, { filters: { objectModes: { regions: "none" } } }); assert.equal(graphSurfaceTargets(root).length, 0);
  let allocated = 0, disposed = 0;
  root.traverse(o => { for (const r of [o.geometry, o.material].filter(Boolean)) { allocated++; r.addEventListener("dispose", () => disposed++); } });
  disposeGraphScene(root); assert.equal(disposed, allocated); assert.equal(root.children.length, 0);
});

test("menu hover is reversible; selection moves only on clicks on the same surface, not camera drags", () => {
  const document = new EventTarget(), element = new EventTarget();
  document.defaultView = new EventTarget(); element.ownerDocument = document;
  element.getBoundingClientRect = () => ({ left: 0, top: 0 }); element.focus = () => {};
  const s = surface(); let selected = null, menu = null, preview = null, blocked = false;
  const controller = installGraphContourInteraction({ element, blocked: () => blocked,
    pick: e => e.clientX < 100 ? hit(s, [e.clientX / 100, e.clientY / 100]) : hit({ ...s, key: "other" }),
    getSelection: () => selected, onSelection: value => selected = value, onMenu: value => menu = value,
    onPreview: value => preview = value, menuElement: () => ({ contains: () => false }) });
  const send = (type, extra = {}, target = element) => {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { button: 0, clientX: 40, clientY: 20, ...extra });
    target.dispatchEvent(event); return event;
  };
  assert.ok(send("pointerdown", { button: 2 }).defaultPrevented);
  send("contextmenu", { button: 2 }); assert.ok(menu);
  controller.preview(0); assert.equal(preview.direction, 0); assert.equal(selected, null);
  controller.preview(1); assert.equal(preview.direction, 1);
  send("keydown", { key: "Escape" }, document); assert.equal(menu, null); assert.equal(preview, null);
  send("pointerdown", { button: 2 }); send("contextmenu", { button: 2 }); controller.choose(0);
  assert.equal(selected.index, 0); assert.equal(menu, null); assert.equal(preview, null);
  send("pointerdown", { clientY: 80 }); send("click", { clientY: 80 }); assert.equal(selected.index, 2);
  send("pointerdown"); send("pointermove", { buttons: 1, clientY: 80 }); send("click"); assert.equal(selected.index, 2);
  send("pointerdown", { clientX: 150 }); send("click", { clientX: 150 }); assert.equal(selected.index, 2);
  blocked = true; send("pointerdown", { button: 2 }); send("contextmenu", { button: 2 }); assert.equal(menu, null);
  controller.dispose(); blocked = false; send("contextmenu", { button: 2 }); assert.equal(menu, null);
});
