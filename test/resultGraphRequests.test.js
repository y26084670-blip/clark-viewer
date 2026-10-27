import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createResultGraphReader } from "../src/services/results/resultGraphRequests.js";
import { createResultGraphProcessor } from "../src/services/results/resultGraphProcessor.js";
import { calculateResultGraphs, graphSlicePatch } from "../src/services/visualization/resultGraphField.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
import { elementLayout, expectedPointCount } from "../src/services/results/resultMappings.js";
import { trilinearElementPoint } from "../src/services/visualization/geometryDiscretization.js";

const options = { processorFactory: () => ({ process: async input => calculateResultGraphs(input), close() {} }) };
const request = f => ({ task: f.task, slices: [{ id: 1, recordIndex: 0, direction: 0, component: 0 }], regions: [], time: 0, quantities: { elements: "J", regions: "Bs", virtual: "Bv" } });
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test("one-based discrete selects every EO layer, including first/last, without rereading the grid", async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  const dimensions = [4,3,2], sizes = [40,20,10];
  for (const direction of [0,1,2]) for (let discrete = 1; discrete <= dimensions[direction]; discrete++) {
    const { graphs, errors } = await reader.read({ ...r, slices: [{ ...r.slices[0], direction, discrete, component: direction }] });
    assert.deepEqual(errors, []);
    for (const surface of graphs[0].surfaces) for (let n = 0; n < surface.values.length; n++) {
      const p = Array.from(surface.positions.subarray(n * 3, n * 3 + 3));
      near(p[direction], sizes[direction] * (discrete - .5) / dimensions[direction] + (direction === 0 ? 60 * surface.instance.ps : 0));
      near(surface.values[n], [p[0], 2 * p[1], -p[2]][direction]);
    }
  }
  assert.equal(f.reads.length, 1);
  for (const discrete of [0,5,1.5,NaN,Infinity]) {
    const bad = await reader.read({ ...r, slices: [{ ...r.slices[0], discrete }] });
    assert.equal(bad.graphs.length, 0); assert.match(bad.errors[0].message, /Номер дискрета/);
  }
  reader.close();
});

test("a single EO layer is exactly central; odd and even counts choose valid central centres", () => {
  const vertices = [[0,0,0],[40,0,0],[0,20,0],[40,20,0],[0,0,10],[40,0,10],[0,20,10],[40,20,10]];
  for (const [count, expected] of [[1,20],[3,20],[4,15]]) {
    const patch = graphSlicePatch(vertices, 0, [count,2,2]);
    for (let n = 0; n < patch.positions.length / 3; n++) near(patch.positions[n * 3], expected);
  }
});

for (const direction of [0, 1, 2]) test(`DV${direction + 1} defaults to the central EO layer and reconstructs signed affine components in every saved image`, async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  const result = await reader.read({ ...r, slices: [0, 1, 2].map(component => ({ ...r.slices[0], id: component + 1, direction, component })) });
  assert.deepEqual(result.errors, []); assert.equal(f.reads.length, 1); assert.equal(f.reads[0].every, 1);
  for (const graph of result.graphs) for (const surface of graph.surfaces) {
    assert.equal(graph.surfaces.length, 2);
    for (let n = 0; n < surface.values.length; n++) {
      const p = Array.from(surface.positions.subarray(n * 3, n * 3 + 3));
      near(p[direction], [15 + 60 * surface.instance.ps, 10, 2.5][direction]);
      near(surface.values[n], [p[0], 2 * p[1], -p[2]][graph.component]);
      near(surface.normals[n * 3 + direction], 1);
    }
  }
  reader.close();
});

test("area graphs preserve all saved nodes, RGB component identities and physical mirror parity", async () => {
  const f = graph3DTask({ mirror: 0 }), reader = createResultGraphReader(options);
  const { graphs, errors } = await reader.read({ ...request(f), slices: [], regions: [0] });
  assert.deepEqual(errors, []); assert.equal(graphs.length, 1); assert.equal(graphs[0].surfaces.length, 6);
  for (const surface of graphs[0].surfaces) {
    assert.equal(surface.values.length, 20); assert.equal(surface.indices.length, 72);
    for (let n = 0; n < surface.values.length; n++) {
      const p = surface.positions.subarray(n * 3, n * 3 + 3);
      near(surface.values[n], [p[0], 2 * p[1], -p[2]][surface.component]);
    }
  }
  reader.close();
});

test("electric mirrors transform components with opposite parity; scalar products retain their sign and units", async () => {
  const f = graph3DTask({ mirror: 0 }), reader = createResultGraphReader(options), r = request(f);
  const { graphs } = await reader.read({ ...r, slices: [{ ...r.slices[0], component: 1 }] });
  for (const surface of graphs[0].surfaces) for (let n = 0; n < surface.values.length; n++) near(surface.values[n], 2 * surface.positions[n * 3 + 1] * (surface.instance.mirrorX ? -1 : 1));
  const scalar = await reader.read({ ...r, quantities: { ...r.quantities, elements: "JEdot" } });
  assert.deepEqual(scalar.errors, []); assert.equal(scalar.graphs[0].components, 1);
  for (const surface of scalar.graphs[0].surfaces) for (let n = 0; n < surface.values.length; n++) {
    const [x, y, z] = surface.positions.subarray(n * 3, n * 3 + 3); near(surface.values[n], (2 * Math.abs(x) - 2 * y - .5 * z) * .001);
  }
  reader.close();
});

test("unstored physical periodic images are generated once with the physical sign", async () => {
  const f = graph3DTask({ images: 1 }), reader = createResultGraphReader(options);
  f.task.elements[0].symPs = 2; f.task.elements[0].symKyp = -1;
  const { graphs, errors } = await reader.read(request(f));
  assert.deepEqual(errors, []); assert.equal(graphs[0].surfaces.length, 2);
  const [a, b] = graphs[0].surfaces;
  for (let n = 0; n < a.values.length; n++) near(b.values[n], -a.values[n]);
  reader.close();
});

test("component/direction/added-slice edits reuse complete saved grids, while time, quantity and task invalidate them", async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  const first = await reader.read(r); const reference = first.graphs[0].referenceMaximum;
  await reader.read({ ...r, slices: [{ ...r.slices[0], direction: 2, component: 2 }] });
  await reader.read({ ...r, slices: [...r.slices, { ...r.slices[0], id: 2, direction: 1 }] });
  assert.equal(f.reads.length, 1);
  const later = await reader.read({ ...r, time: 1 }); assert.equal(f.reads.length, 2); assert.equal(later.graphs[0].referenceMaximum, reference);
  await reader.read({ ...r, time: 1, quantities: { ...r.quantities, elements: "E" } }); assert.equal(f.reads.length, 3);
  const another = graph3DTask(); await reader.read(request(another)); assert.equal(another.reads.length, 1);
  reader.close();
});

test("missing steps and truncated/nonfinite buffers report errors without fabricated surfaces", async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  const missing = await reader.read({ ...r, time: 9 }); assert.match(missing.errors[0].message, /Нет сохранённого момента/); assert.equal(f.reads.length, 0);
  const read = f.task.reader.read; f.task.reader.read = async r => ({ ...await read(r), count: 1 });
  const malformed = await reader.read({ ...r, time: 1 }); assert.match(malformed.errors[0].message, /Неполная сетка/); assert.equal(malformed.graphs.length, 0);
  f.task.reader.read = read; f.buffers.JE[0][0] = Infinity;
  const bad = await reader.read(r); assert.match(bad.errors[0].message, /Нечисловые/); reader.close();
});

test("HV field storage permutations do not permute the user's DV plane", async () => {
  for (const indAmp of [1, 2, 3]) {
    const f = graph3DTask({ images: 1 }), record = f.task.elements[0]; f.task.elements = [record]; record.targ = 3; record.indAmp = indAmp;
    const order = ({1:[4,0,6,2,5,1,7,3],2:[0,4,1,5,2,6,3,7],3:[2,0,3,1,6,4,7,5]})[indAmp];
    const layout = elementLayout(record, true), [n1, n2, n3] = layout.dimensions, values = [];
    const vertices = order.flatMap(i => record.geo[i]);
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) for (let k = 0; k < n3; k++) {
      const p = trilinearElementPoint(vertices, (i + .5) / n1, (j + .5) / n2, (k + .5) / n3); values.push(...p, p[0], 2 * p[1], -p[2]);
    }
    f.task.metadata.HV = { header: { stride: 6, numbs: [expectedPointCount(record, "HV")], inds1: [1] }, steps: [{ index: 0 }] };
    f.buffers.HV = [Float64Array.from(values)]; const reader = createResultGraphReader(options);
    for (const direction of [0, 1, 2]) {
      const r = request(f); const discrete = [4,3,2][direction];
      const result = await reader.read({ ...r, slices: [{ ...r.slices[0], direction, discrete, component: 1 }] });
      assert.deepEqual(result.errors, [], `indAmp=${indAmp}, DV${direction+1}`);
      const surface = result.graphs[0].surfaces[0];
      for (let n = 0; n < surface.values.length; n++) { near(surface.positions[n * 3 + direction], [35,50/3,7.5][direction]); near(surface.values[n], 2 * surface.positions[n * 3 + 1]); }
    }
    reader.close();
  }
});

test("undefined conductivity makes holes in the surface, never zero-valued triangles", async () => {
  const f = graph3DTask({ images: 1, dimensions: [12, 3, 3], field: () => [1, 0, 0] }); f.task.elements[0].model = 2;
  const handle = { getDirectoryHandle: async () => handle, getFileHandle: async () => ({ getFile: async () => ({ text: async () => JSON.stringify({j_gmin:1}) }) }) }; f.task.handle = handle;
  for (let n = 4 * 9; n < 7 * 9; n++) f.buffers.JE[0].fill(0, n * 9 + 6, n * 9 + 9);
  const reader = createResultGraphReader(options), r = request(f);
  const result = await reader.read({ ...r, quantities: { elements: "sigmaRelative" }, slices: [{ ...r.slices[0], direction: 2 }] });
  assert.deepEqual(result.errors, []); const surface = result.graphs[0].surfaces[0];
  assert.ok(surface.values.some(Number.isNaN)); assert.ok(surface.values.some(Number.isFinite));
  assert.ok([...surface.indices].every(n => Number.isFinite(surface.values[n]))); reader.close();
});

test("real surface worker leaves cached inputs intact and terminates cleanly", async () => {
  const url = new URL("../src/workers/resultGraph.worker.js", import.meta.url).href;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');global.self = {postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`, { eval: true });
  const adapter = { postMessage: (...args) => worker.postMessage(...args), terminate: () => worker.terminate() };
  worker.on("message", data => adapter.onmessage?.({ data })); worker.on("error", error => adapter.onerror?.(error));
  const processor = createResultGraphProcessor({ workerFactory: () => adapter });
  const f = graph3DTask(), original = f.buffers.JE[0].slice(), reader = createResultGraphReader({ processorFactory: () => processor });
  try {
    assert.deepEqual((await reader.read(request(f))).errors, []);
    assert.deepEqual((await reader.read({ ...request(f), slices: [{ ...request(f).slices[0], direction: 2 }] })).errors, []);
    assert.equal(f.reads.length, 1); assert.deepEqual(f.buffers.JE[0], original);
  } finally { reader.close(); }
  await assert.rejects(processor.process({ domains: [], graphs: [] }), { name: "AbortError" });
});

test("closing a pending reader prevents interpolation and late publication", async () => {
  const f = graph3DTask(), original = f.task.reader.read; let release, processed = false;
  f.task.reader.read = r => new Promise(resolve => { release = async () => resolve(await original(r)); });
  const reader = createResultGraphReader({ processorFactory: () => ({ process() { processed = true; }, close() {} }) });
  const pending = reader.read(request(f)); reader.close(); await release(); await assert.rejects(pending, { name: "AbortError" }); assert.equal(processed, false);
});

test("warped hexahedra use the parametric EO-layer surface with consistently oriented local normals", () => {
  const vertices = [[0,0,0],[2,0,0],[0,2,0],[2,2,0],[0,0,2],[2,0,3],[0,2,2],[2,2,4]];
  const patch = graphSlicePatch(vertices, 2, [4,4,3], 2);
  const mid = Math.floor(patch.positions.length / 6); const p = patch.positions.subarray(mid * 3, mid * 3 + 3);
  assert.ok(p[2] > 1); for (let n = 0; n < patch.normals.length / 3; n++) assert.ok(patch.normals[n * 3 + 2] > 0);
});
