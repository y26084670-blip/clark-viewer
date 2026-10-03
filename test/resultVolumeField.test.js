import test from "node:test";
import assert from "node:assert/strict";
import { buildResultVolumeField, ResultVolumeLimitError } from "../src/services/visualization/resultVolumeField.js";
import { resultVolumeDomains, vectorScene } from "../src/services/results/resultPlots.js";
import { QUANTITIES, elementLayout } from "../src/services/results/resultMappings.js";
import { readResultVolumeFrame, VOLUME_MAX_NODES } from "../src/services/results/resultVolumeRequests.js";

function grid({ key = "first", dimensions = [2, 2, 2], transform = (x, y, z) => [x, y, z], value = (x, y, z) => 3 + 2 * x - y + 0.5 * z } = {}) {
  const positions = [], values = [], points = [];
  for (let x = 0; x < dimensions[0]; x++) for (let y = 0; y < dimensions[1]; y++) for (let z = 0; z < dimensions[2]; z++) {
    const p = transform(x, y, z);
    positions.push(...p); values.push(value(...p)); points.push({ origin: p });
  }
  return { key, dimensions, positions: new Float64Array(positions), values: new Float64Array(values), points,
    source: { schemaId: "elements", recordIndex: 0 }, instance: { ls: 0, as: 0, ps: 0 } };
}

function voxelCoordinates(field, index) {
  const [nx, ny] = field.dimensions;
  const xyz = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
  return xyz.map((v, axis) => field.bounds.min[axis] + v / (field.dimensions[axis] - 1) * (field.bounds.max[axis] - field.bounds.min[axis]));
}

test("volume tetrahedra reproduce an affine field in saved skew world coordinates", () => {
  const domain = grid({ dimensions: [3, 3, 3], transform: (x, y, z) => [1000 + x + 0.2 * y, -200 + y + 0.3 * z, 12 + z + 0.1 * x] });
  const result = buildResultVolumeField({ domains: [domain], maxAxis: 17 });
  assert.equal(result.domains.length, 1);
  const field = result.domains[0];
  let checked = 0, outside = 0;
  for (let i = 0; i < field.values.length; i++) {
    if (!field.mask[i]) { outside++; continue; }
    const [x, y, z] = voxelCoordinates(field, i);
    assert.ok(Math.abs(field.values[i] - (3 + 2 * x - y + 0.5 * z)) < 3e-4);
    checked++;
  }
  assert.ok(checked > 100);
  assert.ok(outside > 0, "the bounding box outside the actual skew cells must stay empty");
  assert.equal(result.fallbackPoints.length, 0);
});

test("separate sources and symmetry copies never interpolate across the gap", () => {
  const first = grid({ value: () => 2 });
  const second = grid({ key: "other-LS", transform: (x, y, z) => [10 + x, y, z], value: () => 9 });
  second.instance = { ls: 1, as: 0, ps: 0 };
  const result = buildResultVolumeField({ domains: [first, second], maxAxis: 8 });
  assert.equal(result.domains.length, 2);
  assert.deepEqual(result.domains.map(field => [field.bounds.min[0], field.bounds.max[0]]), [[0, 1], [10, 11]]);
  assert.deepEqual(result.domains.map(field => field.instance.ls), [0, 1]);
  for (const [i, field] of result.domains.entries()) assert.ok(field.values.every((v, n) => !field.mask[n] || v === [2, 9][i]));
});

test("a missing node masks its cell without bridging the hole", () => {
  const domain = grid({ dimensions: [4, 2, 2], value: () => 7 });
  domain.values[4] = NaN;
  const { domains: [field] } = buildResultVolumeField({ domains: [domain], maxAxis: 16 });
  for (let i = 0; i < field.mask.length; i++) {
    const [x] = voxelCoordinates(field, i);
    if (x < 2) assert.equal(field.mask[i], 0);
    if (x > 2) assert.equal(field.mask[i], 255);
  }
});

test("planar and degenerate grids retain only their original point fallback", () => {
  const planar = grid({ dimensions: [3, 3, 1] });
  const flattened = grid({ key: "flat", transform: (x, y) => [x, y, 4] });
  const result = buildResultVolumeField({ domains: [planar, flattened] });
  assert.equal(result.domains.length, 0);
  assert.equal(result.fallbackPoints.length, planar.points.length + flattened.points.length);
  assert.match(result.notice, /Плоские|вырожденные/);
});

test("reflected symmetry grids remain valid while folded cells are not filled", () => {
  const mirrored = grid({ transform: (x, y, z) => [-x, y, z] });
  const valid = buildResultVolumeField({ domains: [mirrored], maxAxis: 8 });
  assert.equal(valid.domains.length, 1);
  assert.ok(valid.domains[0].mask.every(value => value === 255));
  const folded = grid();
  folded.positions.set([-1, 1, 1], folded.positions.length - 3);
  const invalid = buildResultVolumeField({ domains: [folded], maxAxis: 8 });
  assert.equal(invalid.domains.length, 0);
  assert.equal(invalid.fallbackPoints.length, folded.points.length);
});

test("time updates reuse spatial weights while updating all values and holes", () => {
  const domain = grid();
  const first = buildResultVolumeField({ domains: [domain], maxAxis: 8 });
  const changed = { ...domain, positions: domain.positions.slice(), values: domain.values.map(v => v + 17) };
  const second = buildResultVolumeField({ domains: [changed], previous: first, maxAxis: 8 });
  assert.equal(second.domains[0].samplingPlan, first.domains[0].samplingPlan);
  for (let i = 0; i < first.domains[0].values.length; i++) {
    assert.ok(Math.abs(second.domains[0].values[i] - first.domains[0].values[i] - 17) < 3e-6);
  }
  const moved = grid({ transform: (x, y, z) => [x + 0.25, y, z] });
  const third = buildResultVolumeField({ domains: [moved], previous: second, maxAxis: 8 });
  assert.notEqual(third.domains[0].samplingPlan, second.domains[0].samplingPlan);
  const missing = { ...changed, values: changed.values.map(() => NaN) };
  const fourth = buildResultVolumeField({ domains: [missing], previous: second, maxAxis: 8 });
  assert.equal(fourth.domains.length, 0);
});

test("voxel allocation is globally bounded and domain count fails explicitly", () => {
  const domains = Array.from({ length: 11 }, (_, i) => grid({ key: String(i) }));
  const result = buildResultVolumeField({ domains, maxVoxels: 1000 });
  assert.ok(result.domains.reduce((sum, field) => sum + field.values.length, 0) <= 1000);
  assert.throws(() => buildResultVolumeField({ domains: Array.from({ length: 129 }, () => domains[0]) }), ResultVolumeLimitError);
  assert.throws(() => buildResultVolumeField({ domains: [{ ...domains[0], positions: new Float64Array(3) }] }), /Полная сетка/);
});

const record = { id: 1, recordIndex: 0, name: "test", targ: 0, xapName: "steel", rv: 0,
  dp: [[2], [2], [2]], symLs: 2, symAs: 2, symPs: 2, symKya: 0, symKyp: 0 };

function elementFrame(source = record, file = "MH") {
  const layout = elementLayout(source, file === "HV" || file === "AV");
  const values = new Float64Array(layout.count * 9);
  for (let row = 0; row < layout.count; row++) {
    const { i1, i2, i3, ls, as, ps } = layout.indices(row);
    values.set([i1 + 10 * ls, i2 + 10 * as, i3 + 10 * ps, 1 + ls, 2 + as, 3 + ps, 0, 0, 0], row * 9);
  }
  return { values, stride: 9, count: layout.count, every: 1 };
}

test("result volume grids unpack LS/AS/PS independently and preserve saved XYZ", () => {
  const frame = elementFrame();
  const frames = [{ record, frame }];
  const scene = vectorScene(frames, QUANTITIES.M);
  const domains = resultVolumeDomains(frames, QUANTITIES.M, scene);
  assert.equal(domains.length, 8);
  for (const domain of domains) {
    assert.equal(domain.values.length, 8);
    assert.equal(domain.points.length, 8);
    const { ls, as, ps } = domain.instance;
    assert.deepEqual(Array.from(domain.positions.subarray(0, 3)), [10 * ls, 10 * as, 10 * ps]);
    assert.ok(domain.values.every(v => v === Math.hypot(1 + ls, 2 + as, 3 + ps)));
  }
  assert.throws(() => resultVolumeDomains([{ record, frame: { ...frame, every: 2 } }], QUANTITIES.M, scene), /полная сетка/);
});

test("virtual grids honor indAmp ordering and all saved geometric images", () => {
  const source = { ...record, targ: 3, indAmp: 1, dp: [[2], [3], [4]], symKya: 1, symKyp: 1 };
  const frame = elementFrame(source, "HV"), frames = [{ record: source, frame }];
  const domains = resultVolumeDomains(frames, QUANTITIES.Bv, vectorScene(frames, QUANTITIES.Bv));
  assert.equal(domains.length, 8);
  assert.deepEqual(domains[0].dimensions, [4, 3, 2]);
  assert.deepEqual(Array.from(domains[0].positions.slice(-3)), [3, 2, 1]);
});

test("volume reader reads a complete grid and reuses only its spatial plan", async () => {
  const frame = elementFrame();
  const reads = [];
  const task = { elements: [record], metadata: { MH: { steps: [0, 1], header: { inds1: [1], numbs: [frame.count] } } },
    reader: { read: async request => { reads.push(request); return frame; } } };
  const request = { task, quantityKey: "M", selected: [1], time: 0, budget: VOLUME_MAX_NODES };
  const first = await readResultVolumeFrame(request);
  assert.equal(reads[0].every, 1);
  assert.equal(reads[0].count, frame.count);
  assert.equal(first.volumeFields.domains.length, 8);
  const next = await readResultVolumeFrame({ ...request, time: 1 }, first.volumeFields);
  assert.equal(reads[1].step, 1);
  assert.equal(next.volumeFields.domains[0].samplingPlan, first.volumeFields.domains[0].samplingPlan);
});

test("volume reader announces the full-node limit and reads only bounded point samples", async () => {
  const source = { ...record, dp: [[VOLUME_MAX_NODES + 1], [1], [1]], symLs: 1, symAs: 1, symPs: 1 };
  let count = 0;
  const task = { elements: [source], metadata: { MH: { steps: [0], header: { inds1: [1], numbs: [VOLUME_MAX_NODES + 1] } } },
    reader: { read: async request => { const sampled = Math.ceil(request.count / request.every); count += sampled;
      return { values: new Float64Array(sampled * 9), count: sampled, stride: 9, every: request.every, start: request.start }; } } };
  const result = await readResultVolumeFrame({ task, quantityKey: "M", selected: [1], time: 0 });
  assert.ok(count <= 5000);
  assert.equal(result.volumeFields.domains.length, 0);
  assert.equal(result.volumeFields.fallbackPoints.length, result.scene.vectors.length);
  assert.equal(result.sampled, true);
  assert.match(result.volumeNotice, /предел/);
  assert.match(result.volumeNotice, /выборка/);
});
