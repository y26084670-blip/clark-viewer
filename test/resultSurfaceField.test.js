import test from "node:test";
import assert from "node:assert/strict";
import { buildResultSurfaceField, isResultSurfaceDomain } from "../src/services/visualization/resultSurfaceField.js";
import { buildResultVolumeField } from "../src/services/visualization/resultVolumeField.js";
import { readResultVolumeFrame, VOLUME_MAX_NODES } from "../src/services/results/resultVolumeRequests.js";

function domain({ n1 = 2, n2 = 3, ls = 0, value = (i, j) => 10 + i + j } = {}) {
  const positions = [], values = [], points = [];
  for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
    const origin = [7 + 2 * i, -3 + j, 5 + i + 2 * j + 20 * ls];
    positions.push(...origin); values.push(value(i, j)); points.push({ origin });
  }
  return { key: `regions:0:${ls}:0:0`, source: { schemaId: "regions", recordIndex: 0 },
    instance: { ls, as: 0, ps: 0 }, dimensions: [n1, n2, 1],
    positions: new Float64Array(positions), values: new Float64Array(values), points };
}

function taskFixture(specs = [{}], Type = Float64Array) {
  let start = 0;
  const regions = specs.map((spec, recordIndex) => ({ id: recordIndex + 1, recordIndex,
    name: `area ${recordIndex + 1}`, dp: [[spec.n1 ?? 2], [spec.n2 ?? 3]], symLs: spec.copies ?? 1 }));
  const numbs = regions.map(r => r.dp[0][0] * r.dp[1][0] * r.symLs);
  const inds1 = numbs.map(count => { const first = start + 1; start += count; return first; });
  const reads = [];
  const task = { regions, general: { countTimeSteps: 2, timeStep: 0.1 },
    metadata: Object.fromEntries(["HS", "AS"].map(file => [file, { steps: [0, 1, 2], header: { numbs, inds1 } }])),
    reader: { async read(request) {
      reads.push(request);
      const { start, count, every = 1, step } = request;
      const rows = Math.ceil(count / every), values = new Type(rows * 6);
      for (let sampled = 0; sampled < rows; sampled++) {
        const row = start + sampled * every;
        const recordIndex = inds1.findIndex((first, index) => row >= first - 1 && row < first - 1 + numbs[index]);
        const record = regions[recordIndex], spec = specs[recordIndex];
        const local = row - inds1[recordIndex] + 1, nodes = record.dp[0][0] * record.dp[1][0];
        const ls = Math.floor(local / nodes), node = local % nodes;
        const i = Math.floor(node / record.dp[1][0]), j = node % record.dp[1][0];
        const origin = spec.degenerate ? [i + j, 0, 0]
          : [7 + 2 * i + recordIndex * 100, -3 + j, 5 + i + 2 * j + 20 * ls];
        const magnitude = spec.value ?? 1 + i + j + 10 * ls + 100 * step;
        values.set([...origin, magnitude, 0, 0], sampled * 6);
      }
      return { values, count: rows, stride: 6, every, start };
    } } };
  return { task, reads };
}

test("area topology uses exact saved nodes with two triangles per cell and separate local images", () => {
  const first = domain(), second = domain({ ls: 1 });
  const field = buildResultSurfaceField({ domains: [first, second] });
  assert.equal(field.surfaces.length, 2); assert.equal(field.fallbackPoints.length, 0); assert.equal(field.notice, "");
  const surface = field.surfaces[0];
  assert.equal(surface.positions, first.positions); assert.equal(surface.values, first.values); assert.equal(surface.points, first.points);
  assert.deepEqual(surface.dimensions, [2, 3, 1]);
  assert.deepEqual([...surface.indices], [0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2]);
  assert.equal(surface.positions.length, first.points.length * 3, "no extra boundary nodes or thickness");
  assert.equal(field.minimum, 10); assert.equal(field.maximum, 13);
  assert.equal(field.surfaces[1].instance.ls, 1);
  assert.equal(isResultSurfaceDomain({ ...first, source: { schemaId: "elements" } }), false);
});

test("zero, constant, mirrored and small-coordinate area fields remain continuous", () => {
  for (const scalar of [0, -7, 17]) for (const size of [1, 1e-10]) {
    const input = domain({ value: () => scalar });
    for (let i = 0; i < input.positions.length; i++) input.positions[i] *= (i % 3 === 0 ? -size : size);
    const field = buildResultSurfaceField({ domains: [input] });
    assert.equal(field.surfaces.length, 1); assert.equal(field.minimum, scalar); assert.equal(field.maximum, scalar);
    assert.ok(field.surfaces[0].values.every(value => value === scalar));
  }
});

test("malformed, degenerate, bow-tie and line grids retain only their original fallback nodes", () => {
  const missing = domain(); missing.positions = missing.positions.subarray(3);
  const invalid = domain(); invalid.values[2] = NaN;
  const collapsed = domain(); collapsed.positions.fill(0);
  const bowtie = domain({ n2: 2 }); bowtie.positions.set([0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0]);
  const line = domain({ n1: 1 });
  for (const input of [missing, invalid, collapsed, bowtie, line]) {
    const field = buildResultSurfaceField({ domains: [input] });
    assert.equal(field.surfaces.length, 0); assert.deepEqual(field.fallbackPoints, input.points);
    assert.deepEqual(field.fallbackDomainKeys, [input.key]); assert.match(field.notice, /Цветные узлы вместо поверхности/);
  }
  const large = domain(); large.positions = new Float64Array(0);
  large.points = Array.from({ length: VOLUME_MAX_NODES }, (_, index) => ({ index }));
  assert.equal(buildResultSurfaceField({ domains: [large] }).fallbackPoints.length, VOLUME_MAX_NODES);
});

for (const Type of [Float32Array, Float64Array]) for (const [quantityKey, name, unit, factor] of [
  ["Bs", "HS", "Тл", 1], ["As", "AS", "Тл·м", 4 * Math.PI * 1e-7],
]) test(`${quantityKey}/${Type.name}: real result read keeps units, time and LS without calling the volume processor`, async () => {
  const { task, reads } = taskFixture([{ copies: 2 }], Type);
  let processorCalls = 0;
  const processor = { process() { processorCalls++; throw new Error("2D areas must not enter volume worker"); } };
  const first = await readResultVolumeFrame({ task, quantityKey, selected: [1], time: 0 }, null, processor);
  const next = await readResultVolumeFrame({ task, quantityKey, selected: [1], time: 2 }, first.volumeFields, processor);
  assert.equal(processorCalls, 0);
  assert.deepEqual(reads.map(read => [read.name, read.step, read.every, read.count]), [[name, 0, 1, 12], [name, 2, 1, 12]]);
  assert.equal(first.volumeFields.domains.length, 0); assert.equal(first.volumeFields.surfaces.length, 2);
  assert.equal(first.volumeFields.fallbackPoints.length, 0); assert.equal(first.volumeNotice, "");
  assert.equal(first.volumeFields.minimum, factor); assert.equal(first.volumeFields.maximum, 14 * factor);
  for (let ls = 0; ls < 2; ls++) {
    const surface = first.volumeFields.surfaces[ls], later = next.volumeFields.surfaces[ls];
    assert.equal(surface.instance.ls, ls); assert.equal(surface.points.length, 6);
    for (let node = 0; node < 6; node++) {
      assert.equal(surface.points[node].unit, unit);
      assert.deepEqual([...surface.positions.subarray(node * 3, node * 3 + 3)], surface.points[node].origin);
      assert.ok(Math.abs(surface.values[node] - surface.points[node].magnitude) < factor * 1e-12);
      assert.ok(Math.abs(later.values[node] - surface.values[node] - 200 * factor) < factor * 1e-10);
    }
    assert.deepEqual(later.positions, surface.positions);
  }
});

test("real read returns zero/constant surface ranges and never introduces an empty volume's zero minimum", async () => {
  for (const scalar of [0, 17]) {
    const { task } = taskFixture([{ value: scalar }]);
    const { volumeFields } = await readResultVolumeFrame({ task, quantityKey: "Bs", selected: [1], time: 0 });
    assert.equal(volumeFields.surfaces.length, 1); assert.equal(volumeFields.minimum, scalar); assert.equal(volumeFields.maximum, scalar);
    assert.ok(volumeFields.surfaces[0].values.every(value => value === scalar));
  }
});

test("mixed plane/line/degenerate regions use one fallback budget while only nonsurface grids reach volume processing", async () => {
  const { task } = taskFixture([{}, { n1: 1, n2: 8 }, { n1: 3, n2: 4, degenerate: true, copies: 2 }]);
  const routed = [];
  const processor = { process(domains) { routed.push(...domains); return buildResultVolumeField({ domains }); } };
  const result = await readResultVolumeFrame({ task, quantityKey: "Bs", selected: [1, 2, 3], time: 0, fallbackBudget: 6 }, null, processor);
  assert.equal(result.volumeFields.surfaces.length, 1); assert.equal(routed.length, 1);
  assert.deepEqual(routed[0].dimensions, [1, 8, 1]);
  assert.equal(result.volumeFields.domains.length, 0);
  assert.ok(result.volumeFields.fallbackPoints.length <= 6);
  assert.equal(new Set(result.volumeFields.fallbackPoints.map(point => `${point.source.recordIndex}:${point.instance.ls}`)).size, 3);
  assert.equal(result.volumeFields.fallbackDomainKeys.length, 3);
  assert.match(result.volumeNotice, /вместо поверхности/); assert.match(result.volumeNotice, /общем пределе кадра/);
  assert.equal(result.sampled, true);
});

test("surface nodes and images obey the shared 100000/128 limits before interpolation", async () => {
  for (const [spec, limitText, expectFullRead] of [
    [{ n1: 317, n2: 316 }, /100.*000/, false],
    [{ copies: 129 }, /128/, true],
  ]) {
    const { task, reads } = taskFixture([spec]);
    let calls = 0;
    const result = await readResultVolumeFrame({ task, quantityKey: "Bs", selected: [1], time: 0, fallbackBudget: 300 }, null,
      { process() { calls++; throw new Error("limit must be checked before processing"); } });
    assert.equal(calls, 0); assert.deepEqual(result.volumeFields.surfaces, []); assert.deepEqual(result.volumeFields.domains, []);
    assert.ok(result.volumeFields.fallbackPoints.length <= 300); assert.equal(result.sampled, true);
    assert.match(result.volumeNotice, limitText);
    assert.equal(reads[0].every === 1, expectFullRead);
    if (spec.copies) assert.equal(new Set(result.volumeFields.fallbackPoints.map(point => point.instance.ls)).size, spec.copies);
  }
});
