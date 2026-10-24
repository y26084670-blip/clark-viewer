import test from "node:test";
import assert from "node:assert/strict";
import { parseCurrentCharacteristic, criticalCurrent, currentFieldBounds, characteristicCurrent,
  currentCharacteristicSeries, readCurrentCharacteristics } from "../src/services/results/currentCharacteristics.js";
import { currentWorkingPointView } from "../src/services/results/workingPointsModel.js";

const material = { j_HC0: 1e30, JC0: 10000, JCa: 1, JCb: 0, j_type: 2, j_gmin: 1e8, j2_n: 29, KHabc: 1 };
const p = parseCurrentCharacteristic(JSON.stringify(material));
const record = { id: 1, recordIndex: 0, name: "Лента", targ: 0, model: 2, xapName: "HTS", rv: 1,
  dp: [[1], [1], [2]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0,
  symVi: [[0], [0], [0]], symR0: [[0], [0], [0]], vkan: [0, 0, 0] };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-11 * Math.abs(expected), `${actual} != ${expected}`);
const observed = { points: [{ x: 1e-34, e: 1e-34, y: 1000, j: 1000 }, { x: 1e-4, e: 1e-4, y: 10000, j: 10000 }] };

test("power characteristic follows the solver resistivity exponent n+1 and native units", () => {
  close(characteristicCurrent(p, 1e-4, 10000), 10000);
  close(characteristicCurrent(p, 1e-34, 10000), 1000);
  close(characteristicCurrent({ ...p, j2_n: 0 }, 2, 10000), 2e8);
  assert.equal(characteristicCurrent(p, 0, 10000), 0);
  assert.ok(characteristicCurrent(p, 1e-300, 10000) > 0);
  assert.throws(() => characteristicCurrent(p, 1, 0), /Jc/);
  assert.throws(() => parseCurrentCharacteristic('{"j_gmin":0}'), /параметры/);
  assert.throws(() => parseCurrentCharacteristic('{"j_type":2,"j2_n":-1}'), /параметры/);
});

test("power-law reference is straight only when both axes are logarithmic", () => {
  const series = currentCharacteristicSeries(record, observed, { property: p,
    bounds: { jcMin: 10000, jcMax: 10000, factorMin: 1, factorMax: 1 } });
  assert.match(series[0].label, /E ∝ J\^30/);
  const points = currentWorkingPointView(series, true, true).series[0].points;
  const a = points[0], b = points.at(-1), slope = (b.y - a.y) / (b.x - a.x);
  close(slope, 1 / 30);
  for (const point of points) close(point.y, a.y + (point.x - a.x) / 30);
  assert.ok(currentWorkingPointView(series, true, false).series[0].points[10].y > 1);
  const normal = currentCharacteristicSeries({ ...record, model: 0 }, observed, { conductivity: 5 });
  normal[0].points.forEach(point => assert.equal(point.j, 5 * point.e));
});

test("tanh inverse reproduces the clipped solver law below and above Jc", () => {
  const tanh = { ...p, j_type: 1, j1_delta: .1, j_gmin: 2 };
  for (const factor of [0, .3, 1]) for (const j of [.001, .1, .5, 1, 2].map(x => 100 * x)) {
    const e = 2 * j / (tanh.j_gmin * (1 + Math.exp(factor * Math.max(0, 1 - j / 100) / tanh.j1_delta)));
    close(characteristicCurrent(tanh, e, 100, factor), j);
  }
});

test("local field uses H+M, the anisotropy axis and KHabc; bounds follow all saved nodes", () => {
  const property = { ...p, j_HC0: 10, JC0: 1000, JCa: 1, JCb: 1, KHabc: 2 };
  const frame = { count: 2, stride: 9, values: new Float64Array([
    0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 5, 0, 0,
  ]) };
  const bounds = currentFieldBounds(property, frame, record, { ...record, vkan: [0, 0, 90] });
  close(bounds.jcMin, 600); close(bounds.jcMax, 700);
  close(bounds.factorMin, .6); close(bounds.factorMax, 1);
  assert.equal(criticalCurrent(property, 10), 0);
  close(criticalCurrent({ ...property, JCb: -1 }, 5), 1000 / 1.5);
  const curves = currentCharacteristicSeries(record, observed, { property, bounds });
  assert.equal(curves.length, 2);
  for (let i = 0; i < curves[0].points.length; i++) assert.ok(curves[0].points[i].j <= curves[1].points[i].j);
});

test("reference reads task-local HTS properties and the selected time's MH, caching only the material", async () => {
  const reads = [], paths = []; let fileReads = 0;
  const lib = { getDirectoryHandle: async name => { paths.push(name); return lib; },
    getFileHandle: async name => { paths.push(name); return { getFile: async () => ({ text: async () => { fileReads++; return JSON.stringify(material); } }) }; } };
  const task = { handle: lib, elements: [record], regions: [], moves: [], general: { htsRo: true, countTimeSteps: 2, timeStep: 1 },
    metadata: { MH: { steps: [0, 1, 2], header: { numbs: [2], inds1: [1] } } },
    reader: { read: async request => { reads.push(request); return { count: 2, stride: 9, values: new Float64Array(18) }; } } };
  for (const time of [0, 2]) {
    const result = await readCurrentCharacteristics(task, [{ record, series: observed }], time);
    assert.equal(result.series.length, 1); assert.deepEqual(result.notes, []);
  }
  assert.deepEqual(paths, ["input3XX", "xapLibHTS", "HTS.txt"]); assert.equal(fileReads, 1);
  assert.deepEqual(reads.map(r => [r.name, r.step, r.every]), [["MH", 0, 1], ["MH", 2, 1]]);
  const missing = await readCurrentCharacteristics({ ...task, metadata: {} }, [{ record, series: observed }], 0);
  assert.equal(missing.series.length, 0); assert.match(missing.notes[0], /MH.h5 отсутствует/);
});
