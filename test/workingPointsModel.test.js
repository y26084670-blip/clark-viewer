import test from "node:test";
import assert from "node:assert/strict";
import { currentWorkingPointSeries, currentWorkingPointView, updateWorkingPointSelection,
  workingPointEligibleIds, workingPointRecords } from "../src/services/results/workingPointsModel.js";

test("all unknown-source elements remain listed; material flags select each working-point tab", () => {
  const task = { elements: [
    { id: 1, targ: 0, xapName: "Сталь", rv: 0 },
    { id: 2, targ: 0, xapName: "", rv: 2 },
    { id: 3, targ: 0, xapName: "Сталь", rv: 2 },
    { id: 4, targ: 0, xapName: " ", rv: 0 },
    { id: 5, targ: 0, model: 1, xapName: "ВТСП", rv: 1 },
    { id: 6, targ: 1, xapName: "Магнит", rv: 0 },
    { id: 7, targ: 2, rv: 1 }, { id: 8, targ: 3 },
  ] };
  const records = workingPointRecords(task);
  assert.deepEqual(records.map(row => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(workingPointEligibleIds(records, "M"), [1, 3, 5]);
  assert.deepEqual(workingPointEligibleIds(records, "J"), [2, 3, 5]);
  assert.deepEqual(workingPointEligibleIds(task.elements, "J"), [2, 3, 5]);
  assert.deepEqual(workingPointRecords(null), []);
});

test("changing one material group's selection preserves the other group", () => {
  assert.deepEqual(updateWorkingPointSelection([1, 2, 3], [2], [2, 3]), [1, 2]);
  assert.deepEqual(updateWorkingPointSelection([1, 2], [1, 3, 7], [1, 3]), [2, 1, 3]);
  assert.deepEqual(updateWorkingPointSelection([1, 2, 3], [], [2, 3]), [1]);
});

const record = { id: 2, name: "Лента", dp: [[1], [1], [4]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const rows = [
  11, 12, 13, -3, 4, 0, 0, -.003, -.004,
  21, 22, 23, 0, 0, -7, -3, 4, 0,
  31, 32, 33, 0, 0, 0, 0, 0, 0,
  41, 42, 43, 8, 0, 0, 1e-25, 0, 0,
];

test("J(E) uses every saved vector norm in native A/mm² and V/m units, for both precisions", () => {
  for (const ArrayType of [Float32Array, Float64Array]) {
    const frame = { stride: 9, count: 4, values: new ArrayType(rows) }, saved = frame.values.slice();
    const series = currentWorkingPointSeries(frame, record);
    assert.equal(series.points.length, 4);
    assert.equal(series.showLine, false);
    assert.ok(Math.abs(series.points[0].x - .005) < 1e-9);
    assert.deepEqual(series.points.map(point => point.y), [5, 7, 0, 8]);
    assert.equal(series.points[1].x, 5);
    const tooltip = series.tooltip(series.points[1]).join("\n");
    assert.match(tooltip, /\|E\|=5 В\/м; \|J\|=7 А\/мм²/);
    assert.match(tooltip, /XYZ = \(21, 22, 23\) мм/);
    assert.match(tooltip, /i1=1; i2=1; i3=2; LS=1; AS=1; PS=1/);
    assert.deepEqual(frame.values, saved);
  }
});

test("log(E) transforms only E, counts exact zeros, retains tiny fields and original tooltip values", () => {
  const series = currentWorkingPointSeries({ stride: 9, count: 4, values: new Float64Array(rows) }, record);
  const original = structuredClone(series.points), view = currentWorkingPointView([series], true);
  assert.equal(view.omittedZeros, 1); assert.equal(view.count, 3);
  const points = view.series[0].points;
  assert.deepEqual(points.map(p => p.row), [0, 1, 3]);
  assert.deepEqual(points.map(p => p.y), [5, 7, 8]);
  assert.deepEqual(points.map(p => p.x), [Math.log10(.005), Math.log10(5), -25]);
  assert.match(view.series[0].tooltip(points[1]).join(" "), /\|E\|=5 В\/м/);
  assert.deepEqual(series.points, original);
  assert.deepEqual(currentWorkingPointView([series]).series[0].points, original);
  const zeros = { ...series, points: [series.points[2]] };
  assert.deepEqual(currentWorkingPointView([zeros], true), { series: [], count: 0, omittedZeros: 1 });
});

test("incomplete, subsampled and nonfinite J(E) frames fail explicitly", () => {
  const frame = { stride: 9, count: 4, values: new Float64Array(rows) };
  for (const invalid of [{ ...frame, count: 3 }, { ...frame, every: 5 }, { ...frame, stride: 6 },
    { ...frame, values: new Float64Array(30) }]) {
    assert.throws(() => currentWorkingPointSeries(invalid, record), /Сетка/);
  }
  for (const value of [NaN, Infinity]) {
    const values = new Float64Array(rows); values[7] = value;
    assert.throws(() => currentWorkingPointSeries({ ...frame, values }, record), /нечисловые/);
  }
});
