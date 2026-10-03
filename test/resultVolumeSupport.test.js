import test from "node:test";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { attachResultVolumeSupport, extendResultVolumeSupport } from "../src/services/results/resultVolumeSupport.js";
import { resultVolumeDomains, vectorScene } from "../src/services/results/resultPlots.js";
import { buildResultVolumeField } from "../src/services/visualization/resultVolumeField.js";
import { readResultVolumeFrame } from "../src/services/results/resultVolumeRequests.js";
import { createResultVolumeProcessor } from "../src/services/results/resultVolumeProcessor.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";

const record = (dimensions = [4, 3, 1]) => ({ id: 1, recordIndex: 0, name: "finite physical cube", targ: 0,
  xapName: "steel", rv: 1, geoType: 0, geo: [[0, 0, 0], [4, 0, 0], [0, 6, 0], [4, 6, 0],
    [0, 0, 8], [4, 0, 8], [0, 6, 8], [4, 6, 8]], dp: dimensions.map(n => [n]),
  dr: [[0], [0], [0]], symVi: [[0], [0], [0]], symR0: [[0], [0], [0]],
  symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0, indMove: 0 });

function fixture({ dimensions = [4, 3, 1], Type = Float64Array, change = {}, translate = [0, 0, 0], value = (x, y, z) => x + y + z } = {}) {
  const source = { ...record(dimensions), ...change };
  const count = dimensions.reduce((a, b) => a * b, 1), values = new Type(count * 9);
  for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) for (let k = 0; k < dimensions[2]; k++) {
    const point = [4 * (i + 0.5) / dimensions[0], 6 * (j + 0.5) / dimensions[1], 8 * (k + 0.5) / dimensions[2]];
    const row = (i * dimensions[1] + j) * dimensions[2] + k;
    values.set([...point.map((v, axis) => v + translate[axis]), value(...point), 0, 0, 0, 0, 0], row * 9);
  }
  const frame = { values, count, stride: 9, every: 1 }, frames = [{ record: source, frame }];
  const task = { elements: [source], general: { countTimeSteps: 1, timeStep: 1 },
    metadata: { MH: { steps: [0, 1], header: { inds1: [1], numbs: [count] } } }, reader: { read: async () => frame } };
  const scene = vectorScene(frames, QUANTITIES.M);
  const domains = resultVolumeDomains(frames, QUANTITIES.M, scene);
  return { frame, task, domains };
}

test("one layer of elementary volumes gets its actual thickness and retains every saved centre", () => {
  const { task, domains } = fixture();
  const supported = attachResultVolumeSupport(domains, { task, quantity: QUANTITIES.M, time: 0 });
  const { domain, reason } = extendResultVolumeSupport(supported[0]);
  assert.equal(reason, ""); assert.deepEqual(domain.dimensions, [6, 5, 3]);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const old = i * 3 + j, next = ((i + 1) * 5 + j + 1) * 3 + 1;
    assert.deepEqual(domain.positions.subarray(next * 3, next * 3 + 3), domains[0].positions.subarray(old * 3, old * 3 + 3));
    assert.equal(domain.values[next], domains[0].values[old]);
    assert.equal(domain.values[next - 1], domain.values[next]);
    assert.equal(domain.values[next + 1], domain.values[next]);
  }
  const result = buildResultVolumeField({ domains: supported, maxAxis: 17 });
  assert.equal(result.domains.length, 1); assert.equal(result.fallbackPoints.length, 0);
  assert.deepEqual(result.domains[0].bounds, { min: [0, 0, 0], max: [4, 6, 8] });
  assert.ok(result.domains[0].mask.every(value => value === 255));
  assert.equal(result.notice, "");
});

test("one elementary volume produces a continuous constant field, including zero", () => {
  for (const scalar of [0, 17]) {
    const { task, domains } = fixture({ dimensions: [1, 1, 1], value: () => scalar });
    const supported = attachResultVolumeSupport(domains, { task, quantity: QUANTITIES.J, time: 0 });
    const result = buildResultVolumeField({ domains: supported, maxAxis: 9 });
    assert.equal(result.domains.length, 1);
    assert.ok(result.domains[0].values.every(value => value === scalar));
    assert.ok(result.domains[0].mask.every(value => value === 255));
    assert.equal(result.domains[0].points.length, 1, "boundary nodes must not become result-picking nodes");
  }
});

test("Float32 coordinates tolerate rounding, while a large global offset cannot hide a geometry mismatch", () => {
  const translate = [7000.125, -9000.875, 15000.0625];
  const { task, domains } = fixture({ dimensions: [3, 5, 1], Type: Float32Array, translate,
    change: { symR0: translate.map(v => [v]) } });
  assert.equal(domains[0].coordinateBytes, 4);
  const supported = attachResultVolumeSupport(domains, { task, quantity: QUANTITIES.M, time: 0 });
  assert.equal(extendResultVolumeSupport(supported[0]).reason, "");
  const shifted = fixture({ translate: [1e12 + 1, 0, 0], change: { symR0: [[1e12], [0], [0]] } });
  const mismatch = attachResultVolumeSupport(shifted.domains, { task: shifted.task, quantity: QUANTITIES.M, time: 0 });
  assert.match(extendResultVolumeSupport(mismatch[0]).reason, /не совпадают/);
});

test("motion positions the physical boundary once; stale saved coordinates cannot be filled", () => {
  const { task, domains } = fixture({ change: { indMove: 1 }, translate: [12, 0, 0] });
  task.moves = [{ position: [[0, 10, 0, 0], [1, 12, 0, 0]], angle: [[0, 0, 0, 0], [1, 0, 0, 0]] }];
  const supported = attachResultVolumeSupport(domains, { task, quantity: QUANTITIES.M, time: 1 });
  const result = buildResultVolumeField({ domains: supported, maxAxis: 9 });
  assert.deepEqual(result.domains[0].bounds, { min: [12, 0, 0], max: [16, 6, 8] });
  const stale = attachResultVolumeSupport(domains, { task, quantity: QUANTITIES.M, time: 0 });
  const rejected = buildResultVolumeField({ domains: stale, maxAxis: 9 });
  assert.equal(rejected.domains.length, 0);
  assert.match(rejected.notice, /координаты HDF5 не совпадают/);
});

test("saved LS/AS/PS use separate physical boundaries and never create absent mirror images", () => {
  const { task, domains } = fixture({ dimensions: [1, 1, 1] });
  task.elements[0] = { ...task.elements[0], symLs: 2, symAs: 2, symPs: 2, symYl: 90, symYa: 90, symTx: 10 };
  task.general.mirrorSymmetryX = 0; task.general.mirrorSymmetryY = 1;
  const copies = [];
  for (let ls = 0; ls < 2; ls++) for (let as = 0; as < 2; as++) for (let ps = 0; ps < 2; ps++) {
    const angle = (ls + as) * Math.PI / 2;
    const origin = [2 + ps * 10, 3 * Math.cos(angle) - 4 * Math.sin(angle), 3 * Math.sin(angle) + 4 * Math.cos(angle)];
    copies.push({ ...domains[0], key: `elements:0:${ls}:${as}:${ps}`, instance: { ls, as, ps }, positions: new Float64Array(origin) });
  }
  const supported = attachResultVolumeSupport(copies, { task, quantity: QUANTITIES.M, time: 0 });
  const result = buildResultVolumeField({ domains: supported, maxAxis: 7 });
  assert.equal(result.domains.length, 8);
  assert.equal(result.fallbackPoints.length, 0);
  assert.deepEqual(result.domains.map(domain => domain.bounds.min[0]), [0, 10, 0, 10, 0, 10, 0, 10]);
  assert.equal(result.notice, "");
});

test("observation planes and virtual saved grids are never padded with invented thickness", () => {
  const { task, domains } = fixture();
  for (const quantity of [QUANTITIES.Bs, QUANTITIES.Bv, QUANTITIES.Av]) {
    const unchanged = attachResultVolumeSupport(domains, { task, quantity, time: 0 });
    assert.equal(unchanged, domains);
    assert.equal(buildResultVolumeField({ domains: unchanged }).domains.length, 0);
  }
});

test("a physical geoType4 pyramid retains its finite volume beside the collapsed boundary face", () => {
  const source = { ...record([1, 1, 1]), geoType: 4, geo: [[4, 4, 0], [6, -8, 3], [2, 0, 0]] };
  const domain = { key: "pyramid", source: { recordIndex: 0 }, instance: { ls: 0, as: 0, ps: 0 },
    dimensions: [1, 1, 1], positions: new Float64Array([4, 3, 2]), values: new Float64Array([9]), points: [] };
  const supported = attachResultVolumeSupport([domain], { task: { elements: [source] }, quantity: QUANTITIES.M, time: 0 });
  const result = buildResultVolumeField({ domains: supported, maxAxis: 17 });
  assert.equal(result.domains.length, 1);
  const field = result.domains[0];
  assert.deepEqual(field.dimensions, [17, 13, 9]);
  // Base: x=0, y=0..6, z=0..4. Apex: (8,3,2). The section
  // at x=6 still has finite area; the former all-six-tetra check omitted it.
  assert.equal(field.mask[(4 * 13 + 6) * 17 + 12], 255);
  assert.equal(field.values[(4 * 13 + 6) * 17 + 12], 9);
  for (let z = 0; z < 9; z++) for (let y = 0; y < 13; y++) for (let x = 0; x < 17; x++) {
    if (!field.mask[(z * 13 + y) * 17 + x]) continue;
    const fraction = x / 16;
    assert.ok(y / 2 >= 3 * fraction - 1e-6 && y / 2 <= 6 - 3 * fraction + 1e-6);
    assert.ok(z / 2 >= 2 * fraction - 1e-6 && z / 2 <= 4 - 2 * fraction + 1e-6);
  }
});

function workerFactory() {
  const url = new URL("../src/workers/resultVolume.worker.js", import.meta.url).href;
  const worker = new NodeWorker(`const {parentPort}=await import('node:worker_threads');
    globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
    await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
  const wrapper = { postMessage: (data, transfer) => worker.postMessage(data, transfer), terminate: () => worker.terminate() };
  worker.on("message", data => wrapper.onmessage?.({ data }));
  worker.on("error", error => wrapper.onerror?.({ message: error.message }));
  return wrapper;
}

test("full result read and the real worker publish volume instead of points for one-layer MH", async () => {
  const { task, frame } = fixture();
  const processor = createResultVolumeProcessor({ workerFactory });
  try {
    const first = await readResultVolumeFrame({ task, quantityKey: "M", selected: [1], time: 0 }, null, processor);
    assert.equal(first.volumeFields.domains.length, 1);
    assert.equal(first.volumeFields.fallbackPoints.length, 0);
    assert.equal(first.scene.vectors.length, frame.count);
    assert.equal(first.volumeNotice, "");
    for (let row = 0; row < frame.count; row++) frame.values[row * 9 + 3] += 5;
    const second = await readResultVolumeFrame({ task, quantityKey: "M", selected: [1], time: 1 }, null, processor);
    assert.equal(second.volumeFields.domains.length, 1);
    for (let i = 0; i < first.volumeFields.domains[0].values.length; i += 97) {
      assert.ok(Math.abs(second.volumeFields.domains[0].values[i] - first.volumeFields.domains[0].values[i] - 5) < 2e-6);
    }
  } finally { processor.close(); }
});
