import test from "node:test";
import assert from "node:assert/strict";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { scalarAt, scalarScene, resultVolumeDomains } from "../src/services/results/resultPlots.js";
import { buildResultVolumeField } from "../src/services/visualization/resultVolumeField.js";
import { createResultLayerReader } from "../src/services/results/resultLayerRequests.js";
import { globalResultRange, resultGlobalScale } from "../src/services/results/resultGlobalScale.js";
import { formatResultScalarTooltip } from "../src/services/visualization/geometryPicking.js";
import { movie3DFilenamePrefix } from "../src/services/movie/movieFilename.js";
import { globalRangesTask } from "../scripts/test-support/globalRangesFixture.js";

const quantity = QUANTITIES.rho;
const record = { id: 1, recordIndex: 0, targ: 0, rv: 1, dp: [[4], [2], [2]],
  symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const makeFrame = rows => ({ values: new Float64Array(rows.flat()), count: rows.length, stride: 9, every: 1, start: 0 });
const close = (actual, expected) => assert.ok(Math.abs(actual / expected - 1) < 1e-12, `${actual} != ${expected}`);

test("resistivity converts saved E/J into Ohm·m for an ohmic conductor and a power law", () => {
  assert.equal(quantity.unit, "Ом·м");
  for (const j of [1e-30, 1, 100]) {
    // 50 MS/m: J [A/mm²] = 50 E [V/m], rho = 2e-8 Ohm·m.
    for (const sign of [-1, 1]) {
      const frame = makeFrame([[0, 0, 0, 0, sign * j, 0, 0, sign * j / 50, 0]]);
      close(scalarAt(frame, 0, quantity), 2e-8);
    }
    // E = Ec (J/Jc)^3, so rho grows as J²; don't divide by prescribed total current.
    const frame = makeFrame([[0, 0, 0, j, 0, 0, 1e-4 * (j / 10) ** 3, 0, 0]]);
    close(scalarAt(frame, 0, quantity), 1e-13 * j ** 2);
  }
  const frame = makeFrame([[0, 0, 0, 3, 4, 0, 0, 0, -10]]);
  close(scalarAt(frame, 0, quantity), 2e-6);
});

test("zero J is omitted, but finite zero E is retained and invalid saved data still fails", () => {
  const frame = makeFrame([
    [0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 1, 0, 0],
    [2, 0, 0, 1, 0, 0, 0, 0, 0], [3, 0, 0, 2, 0, 0, 4, 0, 0],
  ]);
  const scene = scalarScene([{ record, frame }], quantity);
  assert.equal(scene.undefinedCount, 2); assert.match(scene.notice, /J = 0.*2/);
  assert.deepEqual(scene.points.map(p => [p.origin[0], p.value, p.volumeNumber]), [[2, 0, 3], [3, 2e-6, 4]]);
  assert.equal(scene.minimum, 0); assert.equal(scene.maximum, 2e-6);
  assert.match(formatResultScalarTooltip(scene.points[1]), /Удельное сопротивление.*Ом·м/);
  for (const column of [0, 3, 6]) for (const value of [NaN, Infinity]) {
    const invalid = makeFrame([[0, 0, 0, 0, 0, 0, 0, 0, 0]]); invalid.values[column] = value;
    assert.throws(() => scalarScene([{ record, frame: invalid }], quantity), /нечисловые/);
  }
});

test("resistivity volume preserves full topology, masks zero-J cells and updates the mask with time", () => {
  const rows = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) rows.push([x, y, z, 2, 0, 0, 4, 0, 0]);
  const frame = makeFrame(rows); frame.values[4 * 9 + 3] = 0;
  const frames = [{ record, frame }], scene = scalarScene(frames, quantity);
  const domains = resultVolumeDomains(frames, quantity, scene);
  assert.equal(scene.points.length, 15); assert.equal(domains[0].values.length, 16);
  assert.ok(Number.isNaN(domains[0].values[4]));
  const first = buildResultVolumeField({ domains, maxAxis: 16 }), field = first.domains[0];
  for (let i = 0; i < field.mask.length; i++) {
    const x = (i % field.dimensions[0]) / (field.dimensions[0] - 1) * 3;
    if (x < 2) assert.equal(field.mask[i], 0);
    if (x > 2) { assert.equal(field.mask[i], 255); assert.ok(Math.abs(field.values[i] - 2e-6) < 1e-12); }
  }
  frame.values[4 * 9 + 3] = 2;
  const next = resultVolumeDomains(frames, quantity, scalarScene(frames, quantity));
  const second = buildResultVolumeField({ domains: next, previous: first, maxAxis: 16 });
  assert.equal(second.domains[0].samplingPlan, field.samplingPlan);
  assert.ok(second.domains[0].mask.every(value => value === 255));
});

test("resistivity reads all solved JE nodes in point/volume modes; undefined frames are valid movie frames", async () => {
  const task = globalRangesTask(), read = task.reader.read.bind(task.reader), requests = [];
  task.reader.read = async request => {
    requests.push(request);
    const frame = await read(request);
    for (let i = 0; i < frame.count; i++) frame.values.set(request.step ? [2, 0, 0, 4, 0, 0] : [0, 0, 0, 0, 0, 0], i * frame.stride + 3);
    return frame;
  };
  const reader = createResultLayerReader({ processorFactory: () => ({ process: async domains => buildResultVolumeField({ domains }), close() {} }) });
  try {
    for (const volumeMode of [false, true]) for (const time of [0, 1]) {
      const result = await reader.read({ task, time, layers: [{ key: "elements", quantityKey: "rho", selected: [1, 2, 4], volumeMode }] });
      assert.deepEqual(result.errors, []); assert.equal(result.layers[0].state, "ready");
      const scene = result.layers[0].scalarScene;
      if (time) { assert.ok(scene.points.length > 0); assert.ok(scene.points.every(p => p.value === 2e-6)); assert.equal(scene.notice, ""); }
      else { assert.equal(scene.points.length, 0); assert.ok(scene.undefinedCount > 0); assert.match(scene.notice, /J = 0/); }
      assert.ok(requests.every(r => r.name === "JE" && r.every === 1));
      assert.ok(scene.points.every(p => p.source.recordIndex !== 1), "prescribed coil is excluded");
    }
  } finally { reader.close(); }
  assert.equal(movie3DFilenamePrefix([{ quantityKey: "rho", selected: [1] }]), "rho_3d");
});

test("independent E/J global extrema are never presented as extrema of resistivity", () => {
  const task = globalRangesTask();
  assert.equal(globalResultRange(task, "rho", [2]).state, "empty");
  const range = globalResultRange(task, "rho", [1]);
  assert.equal(range.available, false); assert.match(range.reason, /текущего кадра/);
  assert.equal(resultGlobalScale(task, [{ key: "elements", quantityKey: "rho", selected: [1] }]).available, false);
});
