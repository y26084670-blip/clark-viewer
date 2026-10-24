import test from "node:test";
import assert from "node:assert/strict";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { scalarScene, resultVolumeDomains } from "../src/services/results/resultPlots.js";
import { relativeConductivityBases, relativeConductivityValues } from "../src/services/results/relativeConductivity.js";
import { buildResultVolumeField } from "../src/services/visualization/resultVolumeField.js";
import { createResultLayerReader } from "../src/services/results/resultLayerRequests.js";
import { globalResultRange, resultGlobalScale } from "../src/services/results/resultGlobalScale.js";
import { formatResultScalarTooltip } from "../src/services/visualization/geometryPicking.js";
import { movie3DFilenamePrefix } from "../src/services/movie/movieFilename.js";
import { globalRangesTask } from "../scripts/test-support/globalRangesFixture.js";

const quantity = QUANTITIES.sigmaRelative;
const record = { id: 1, recordIndex: 0, targ: 0, model: 2, xapName: "HTS", rv: 1, dp: [[4], [2], [2]],
  symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const makeFrame = rows => ({ values: new Float64Array(rows.flat()), count: rows.length, stride: 9, every: 1, start: 0 });
const bases = { materials: new Map([["HTS", 10], ["HTS2", 20]]), minimum: 10 };
function prepared(frame, material = record, base = bases) {
  return { ...frame, relativeConductivityValues: relativeConductivityValues(frame, material, base) };
}
function libraryTask(elements = [record], materials = { HTS: { j_gmin: 10 }, HTS2: { j_gmin: 20 } }) {
  const files = [], paths = [];
  const handle = { getDirectoryHandle: async name => { paths.push(name); return handle; },
    getFileHandle: async name => { files.push(name); if (!materials[name.slice(0, -4)]) throw new Error("missing " + name);
      return { getFile: async () => ({ text: async () => JSON.stringify(materials[name.slice(0, -4)]) }) }; } };
  return { task: { elements, handle }, files, paths };
}
const close = (actual, expected) => assert.ok(Math.abs(actual / expected - 1) < 1e-12, `${actual} != ${expected}`);

test("each HTS uses its assigned j_gmin; ordinary conductivity uses the minimum across all assigned HTS", async () => {
  const ordinary = { ...record, model: 0, rv: 50, xapName: "" }, other = { ...record, id: 2, xapName: "HTS2" };
  const f = libraryTask([record, other, ordinary, { ...record, id: 4 }]);
  const b = await relativeConductivityBases(f.task); assert.equal(b.minimum, 10);
  const frame = makeFrame([[0, 0, 0, -20, 0, 0, -2, 0, 0]]);
  assert.equal(relativeConductivityValues(frame, record, b)[0], 1);
  assert.equal(relativeConductivityValues(frame, other, b)[0], .5);
  assert.equal(relativeConductivityValues(frame, ordinary, b)[0], 5);
  assert.equal(relativeConductivityValues(makeFrame([[0, 0, 0, 0, 0, 0, 0, 0, 0]]), ordinary, b)[0], 5);
  await relativeConductivityBases(f.task);
  assert.deepEqual(f.files.sort(), ["HTS.txt", "HTS2.txt"]); // per-task material cache
  assert.ok(f.paths.every(path => ["input3XX", "xapLibHTS"].includes(path)));
});

test("the absence of HTS or one invalid/missing assigned material never fabricates a normalization base", async () => {
  const noHts = libraryTask([{ ...record, model: 0 }]);
  await assert.rejects(relativeConductivityBases(noHts.task), /нет материалов ВТСП/); assert.deepEqual(noHts.files, []);
  for (const properties of [{ HTS: { j_gmin: 10 } }, { HTS: { j_gmin: 10 }, HTS2: { j_gmin: 0 } }]) {
    const f = libraryTask([record, { ...record, xapName: "HTS2" }], properties);
    await assert.rejects(relativeConductivityBases(f.task), /не удалось загрузить материалы/);
  }
});

test("relative conductivity uses native JE units, vector norms and every small nonzero E", () => {
  for (const e of [1e-300, 1e-10, 1, 100]) {
    const frame = makeFrame([[0, 0, 0, 0, -30 * e, 0, 0, -e, 0]]);
    close(relativeConductivityValues(frame, record, bases)[0], 3);
  }
  const frame = makeFrame([[0, 0, 0, 3, 4, 0, 0, 0, -2]]);
  close(relativeConductivityValues(frame, record, bases)[0], .25);
});

test("zero E is masked only for HTS, valid zero J remains zero, invalid fields still fail", () => {
  const frame = prepared(makeFrame([
    [0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0, 1, 0, 0], [3, 0, 0, 20, 0, 0, 2, 0, 0],
  ]));
  const scene = scalarScene([{ record, frame }], quantity);
  assert.equal(scene.undefinedCount, 2); assert.match(scene.notice, /E.*0.*2/);
  assert.deepEqual(scene.points.map(p => [p.origin[0], p.value, p.volumeNumber]), [[2, 0, 3], [3, 1, 4]]);
  assert.equal(scene.minimum, 0); assert.equal(scene.maximum, 1);
  assert.match(formatResultScalarTooltip(scene.points[1]), /Относительная электропроводность.*σ\/j_gmin/);
  for (const column of [0, 3, 6]) for (const value of [NaN, Infinity]) {
    const invalid = makeFrame([[0, 0, 0, 0, 0, 0, 0, 0, 0]]); invalid.values[column] = value;
    assert.throws(() => scalarScene([{ record, frame: prepared(invalid) }], quantity), /нечисловые/);
  }
});

test("relative conductivity retains topology and masks zero-E cells without bridging holes", () => {
  const rows = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) rows.push([x, y, z, 20, 0, 0, 2, 0, 0]);
  const raw = makeFrame(rows); raw.values[4 * 9 + 6] = 0;
  const frame = prepared(raw), frames = [{ record, frame }], scene = scalarScene(frames, quantity);
  const domains = resultVolumeDomains(frames, quantity, scene);
  assert.equal(scene.points.length, 15); assert.equal(domains[0].values.length, 16);
  assert.ok(Number.isNaN(domains[0].values[4]));
  const first = buildResultVolumeField({ domains, maxAxis: 16 }), field = first.domains[0];
  for (let i = 0; i < field.mask.length; i++) {
    const x = (i % field.dimensions[0]) / (field.dimensions[0] - 1) * 3;
    if (x < 2) assert.equal(field.mask[i], 0);
    if (x > 2) { assert.equal(field.mask[i], 255); assert.equal(field.values[i], 1); }
  }
  raw.values[4 * 9 + 6] = 2;
  const nextFrames = [{ record, frame: prepared(raw) }];
  const second = buildResultVolumeField({ domains: resultVolumeDomains(nextFrames, quantity, scalarScene(nextFrames, quantity)), previous: first, maxAxis: 16 });
  assert.equal(second.domains[0].samplingPlan, field.samplingPlan);
  assert.ok(second.domains[0].mask.every(value => value === 255));
});

test("mixed point/volume maps use the hidden HTS base and keep ordinary conductors at zero time", async () => {
  const task = globalRangesTask(); task.elements[0] = { ...task.elements[0], model: 2, xapName: "HTS" };
  task.elements[3] = { ...task.elements[3], rv: 50 };
  const lib = libraryTask(task.elements); task.handle = lib.task.handle;
  const original = task.reader.read.bind(task.reader), requests = [];
  task.reader.read = async request => {
    requests.push(request); const frame = await original(request);
    if (request.name === "JE") for (let i = 0; i < frame.count; i++) frame.values.set(request.step ? [20, 0, 0, 2, 0, 0] : [0, 0, 0, 0, 0, 0], i * frame.stride + 3);
    return frame;
  };
  const reader = createResultLayerReader({ processorFactory: () => ({ process: async domains => buildResultVolumeField({ domains }), close() {} }) });
  try {
    for (const volumeMode of [false, true]) for (const selected of [[1, 2, 4], [4]]) for (const time of [0, 1]) {
      const result = await reader.read({ task, time, layers: [{ key: "elements", quantityKey: "sigmaRelative", selected, volumeMode }] });
      assert.deepEqual(result.errors, []); assert.equal(result.layers[0].state, "ready");
      const scene = result.layers[0].scalarScene;
      assert.ok(scene.points.some(p => p.source.recordIndex === 3));
      assert.ok(scene.points.every(p => p.value === (p.source.recordIndex === 0 ? 1 : 5)));
      assert.ok(scene.points.every(p => p.source.recordIndex !== 1)); // prescribed sources excluded
      if (!time && selected.includes(1)) { assert.equal(scene.undefinedCount, 8); assert.match(scene.notice, /E.*0/); }
      else { assert.equal(scene.undefinedCount, 0); assert.equal(scene.notice, ""); }
      assert.ok(requests.every(r => r.name === "JE" && r.every === 1));
    }
    assert.deepEqual(lib.files, ["HTS.txt"]);
    task.handle = null; // loaded material is cached; rendering does not reread it every time
    const mixed = await reader.read({ task, time: 1, layers: [{ key: "elements", quantityKey: "sigmaRelative", selected: [4] }, { key: "regions", quantityKey: "Bs", selected: [1] }] });
    assert.deepEqual(mixed.errors, []); assert.ok(mixed.layers[1].scene.vectors.length > 0);
  } finally { reader.close(); }
  assert.equal(movie3DFilenamePrefix([{ quantityKey: "sigmaRelative", selected: [1] }]), "sigma_rel_3d");
});

test("global E/J bounds do not stand in for extrema of relative conductivity", () => {
  const task = globalRangesTask();
  assert.equal(globalResultRange(task, "sigmaRelative", [2]).state, "empty");
  const range = globalResultRange(task, "sigmaRelative", [1]);
  assert.equal(range.available, false); assert.match(range.reason, /текущего кадра/);
  assert.equal(resultGlobalScale(task, [{ key: "elements", quantityKey: "sigmaRelative", selected: [1] }]).available, false);
});
