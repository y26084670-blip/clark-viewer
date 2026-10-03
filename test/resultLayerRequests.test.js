import test from "node:test";
import assert from "node:assert/strict";
import { createResultLayerReader, allocateResultLayerPointBudgets } from "../src/services/results/resultLayerRequests.js";
import { createResultFrameController, sameFrameContext } from "../src/services/results/resultFrameController.js";
import { boundedVolumeFallbackPoints } from "../src/services/results/resultVolumeRequests.js";
import { buildResultVolumeField } from "../src/services/visualization/resultVolumeField.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(counts = [8, 6, 8]) {
  const physical = { id: 1, recordIndex: 0, targ: 0, rv: 1, xapName: "steel", dp: [[counts[0]], [1], [1]],
    symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
  const virtual = { ...physical, id: 2, recordIndex: 1, targ: 3, dp: [[counts[2]], [1], [1]] };
  const region = { id: 1, recordIndex: 0, dp: [[counts[1]], [1]], symLs: 1 };
  const metadata = Object.fromEntries([["MH", counts[0]], ["JE", counts[0]], ["HS", counts[1]], ["HV", counts[2]]]
    .map(([name, count]) => [name, { steps: [0, 1, 2], header: { inds1: [1], numbs: [count] } }]));
  const reads = [];
  const makeFrame = request => {
    const count = Math.ceil(request.count / (request.every ?? 1));
    const stride = request.name === "MH" || request.name === "JE" ? 9 : 6;
    const base = { MH: 1, JE: 2, HS: 3, HV: 4 }[request.name] + request.step * 100;
    const values = new Float64Array(count * stride);
    for (let row = 0; row < count; row++) {
      const saved = request.start + row * (request.every ?? 1);
      values.set([saved, 0, 0, base, 0, 0], row * stride);
      if (stride === 9) values.set([base * 2, 0, 0], row * stride + 6);
    }
    return { values, stride, count, every: request.every ?? 1, start: request.start };
  };
  const task = { elements: [physical, virtual], regions: [region], metadata,
    reader: { read: async request => { reads.push(request); return makeFrame(request); } } };
  const request = (time = 0, changes = {}) => ({ task, time, layers: [
    { key: "elements", quantityKey: "M", selected: [1], volumeMode: false },
    { key: "regions", quantityKey: "Bs", selected: [1], volumeMode: false },
    { key: "virtual", quantityKey: "Bv", selected: [2], volumeMode: false },
  ].map(layer => ({ ...layer, ...changes[layer.key] })) });
  return { task, reads, request, makeFrame };
}

test("three independent result choices read one time and retain their quantities and units", async () => {
  const f = fixture(), reader = createResultLayerReader();
  const result = await reader.read(f.request(2));
  assert.deepEqual(result.layers.map(layer => [layer.key, layer.quantityKey, layer.state]),
    [["elements", "M", "ready"], ["regions", "Bs", "ready"], ["virtual", "Bv", "ready"]]);
  assert.deepEqual(f.reads.map(read => read.step), [2, 2, 2]);
  assert.deepEqual(result.layers.map(layer => layer.scene.vectors[0].vector[0]), [201, 203, 204]);
  assert.deepEqual(result.layers.map(layer => layer.scene.vectors[0].unit), ["кА/м", "Тл", "Тл"]);
  const scalar = await reader.read(f.request(0, { elements: { quantityKey: "JEdot" } }));
  assert.equal(scalar.layers[0].scene, null);
  assert.ok(scalar.layers[0].scalarScene.points.length > 0);
  assert.ok(scalar.layers[1].scene.vectors.length > 0);
  reader.close();
});

test("none and empty selections do not inspect metadata or read HDF5", async () => {
  const f = fixture(), reader = createResultLayerReader();
  Object.defineProperty(f.task, "metadata", { get() { throw new Error("metadata must not be touched"); } });
  const result = await reader.read(f.request(0, { elements: { quantityKey: "none" }, regions: { selected: [] }, virtual: { quantityKey: "none" } }));
  assert.deepEqual(result.layers.map(layer => layer.state), ["disabled", "empty", "disabled"]);
  assert.deepEqual(result.errors, []); assert.deepEqual(f.reads, []);
  reader.close();
});

test("one group's metadata or read error leaves both other result groups available", async () => {
  const f = fixture(), reader = createResultLayerReader();
  delete f.task.metadata.HS;
  const missing = await reader.read(f.request());
  assert.deepEqual(missing.layers.map(layer => layer.state), ["ready", "error", "ready"]);
  assert.match(missing.layers[1].error, /HS.h5 отсутствует/);
  assert.deepEqual(missing.errors.map(error => error.key), ["regions"]);
  assert.deepEqual(f.reads.map(read => read.name), ["MH", "HV"]);
  f.task.reader.read = async request => {
    if (request.name === "HV") throw new Error("disk read failed");
    return f.makeFrame(request);
  };
  const broken = await reader.read(f.request(1, { regions: { quantityKey: "none" } }));
  assert.deepEqual(broken.layers.map(layer => layer.state), ["ready", "disabled", "error"]);
  assert.match(broken.layers[2].error, /disk read failed/);
  reader.close();
});

test("global point allowances and volume fallback stay below the common 5000-node display limit", async () => {
  const f = fixture([60_000, 8000, 60_000]);
  let processors = 0;
  const reader = createResultLayerReader({ processorFactory: () => { processors++; throw new Error("full-volume worker must not start"); } });
  const result = await reader.read(f.request(0, { elements: { volumeMode: true }, virtual: { volumeMode: true } }));
  assert.ok(result.layers.every(layer => layer.state === "ready"));
  assert.equal(processors, 0);
  assert.ok(result.layers.reduce((sum, layer) => sum + layer.scene.vectors.length, 0) <= 5000);
  for (const index of [0, 2]) {
    assert.equal(result.layers[index].volumeFields.domains.length, 0);
    assert.match(result.layers[index].volumeNotice, /вместе требуют 120/);
    assert.match(result.layers[index].volumeNotice, /общий предел/);
  }
  assert.ok(f.reads.every(read => read.every > 1));
  reader.close();
});

test("fallback sampling retains every symmetry image while sharing the common allowance", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ origin: [index, 0, 0],
    source: { schemaId: "elements", recordIndex: 0 }, instance: { ls: index % 3, as: 0, ps: 0 } }));
  const sampled = boundedVolumeFallbackPoints(points, 7);
  assert.ok(sampled.length <= 7);
  assert.equal(new Set(sampled.map(point => point.instance.ls)).size, 3);
  assert.ok(sampled.every(point => points.includes(point)));
  const { allocations, errors } = allocateResultLayerPointBudgets([
    { key: "too-many-images", minimum: 5001, count: 5001 }, { key: "healthy", minimum: 1, count: 20000 },
  ]);
  assert.equal(allocations.get("healthy"), 5000); assert.equal(errors.size, 1);
});

test("per-group volume processors reuse plans and close on disable, quantity or task changes", async () => {
  const f = fixture(), owners = [];
  const reader = createResultLayerReader({ processorFactory: () => {
    const owner = { calls: 0, closed: false, process: async domains => {
      owner.calls++; return buildResultVolumeField({ domains, maxAxis: 4 });
    }, close: () => { owner.closed = true; } };
    owners.push(owner); return owner;
  } });
  const settings = { elements: { volumeMode: true }, regions: { quantityKey: "none" }, virtual: { volumeMode: true } };
  await reader.read(f.request(0, settings)); assert.equal(owners.length, 2);
  await reader.read(f.request(1, settings)); assert.deepEqual(owners.map(owner => owner.calls), [2, 2]);
  await reader.read(f.request(2, { ...settings, elements: { volumeMode: true, quantityKey: "H" } }));
  assert.equal(owners[0].closed, true); assert.equal(owners[1].closed, false); assert.equal(owners.length, 3);
  const other = fixture();
  await reader.read(other.request(0, settings));
  assert.equal(owners[1].closed, true); assert.equal(owners[2].closed, true); assert.equal(owners.length, 5);
  const count = other.reads.length;
  await reader.read(other.request(1, { elements: { quantityKey: "none" }, regions: { selected: [] }, virtual: { quantityKey: "none" } }));
  assert.ok(owners.every(owner => owner.closed)); assert.equal(other.reads.length, count);
  reader.close(); await assert.rejects(reader.read(f.request()), { name: "AbortError" });
});

test("the controller publishes complete layer frames atomically and coalesces newer times", async () => {
  const f = fixture(), reader = createResultLayerReader(), pending = [], states = [], scheduled = [];
  f.task.reader.read = request => new Promise(resolve => pending.push({ request, finish: () => resolve(f.makeFrame(request)) }));
  const controller = createResultFrameController({ load: reader.read, publish: state => states.push(state),
    schedule: callback => { scheduled.push(callback); return callback; }, cancel: () => {} });
  const start = () => { void scheduled.shift()(); };
  controller.request(f.request(0)); start(); await tick();
  pending[0].finish(); await tick(); assert.equal(states.at(-1).frame, null);
  pending[1].finish(); await tick(); assert.equal(states.at(-1).frame, null);
  pending[2].finish(); await tick(); const frame0 = states.at(-1).frame;
  assert.equal(frame0.request.time, 0);
  controller.request(f.request(1)); start(); await tick();
  pending[3].finish(); await tick(); assert.equal(states.at(-1).frame, frame0);
  controller.request(f.request(2));
  pending[4].finish(); pending[5].finish(); await tick(); assert.equal(states.at(-1).frame, frame0);
  start(); await tick();
  assert.deepEqual(pending.map(item => item.request.step), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
  pending.slice(6).forEach(item => item.finish()); await tick();
  const frame2 = states.at(-1).frame;
  assert.equal(frame2.request.time, 2);
  assert.deepEqual(frame2.value.layers.map(layer => layer.scene.vectors[0].vector[0]), [201, 203, 204]);
  controller.close(); reader.close();
});

test("layer context compares every quantity, selection and volume mode independently of time or order", () => {
  const f = fixture(), first = f.request();
  assert.ok(sameFrameContext(first, f.request(1)));
  assert.ok(sameFrameContext(first, { ...f.request(), layers: [...first.layers].reverse() }));
  for (const [key, change] of [["elements", { quantityKey: "H" }], ["regions", { selected: [] }],
    ["virtual", { volumeMode: true }], ["virtual", { quantityKey: "none" }]]) {
    assert.equal(sameFrameContext(first, f.request(1, { [key]: change })), false);
  }
});

test("closing during a layer read drains outstanding HDF5 reads and cannot publish a late frame", async () => {
  const f = fixture(), pending = [];
  f.task.reader.read = request => new Promise(resolve => pending.push(() => resolve(f.makeFrame(request))));
  const reader = createResultLayerReader();
  let settled = false;
  const result = reader.read(f.request()).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await tick(); assert.equal(pending.length, 3);
  reader.close();
  pending[0](); await tick(); assert.equal(settled, false);
  pending[1](); await tick(); assert.equal(settled, false);
  pending[2]();
  assert.equal((await result).name, "AbortError");
});
