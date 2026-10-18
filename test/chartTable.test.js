import assert from "node:assert/strict";
import test from "node:test";
import { chartTableText } from "../src/services/visualization/chartTable.js";

const table = (...args) => chartTableText(...args).split("\n").map(row => row.split("\t"));

test("three currents share time and have separate, uniquely named columns", () => {
  const series = [[0, -472.43516984502224], [0, 4883.899137776818], [0, -4411.4639679317961]]
    .map(values => ({ label: "Ток", points: values.map((y, step) => ({ x: step * .0005, y, step, time: step * .0005 })) }));
  const rows = table(series, "Время, с", "Ток, А");
  assert.deepEqual(rows[0], ["Время, с", "1. Ток · Ток, А", "2. Ток · Ток, А", "3. Ток · Ток, А"]);
  assert.deepEqual(rows.slice(1), [["0", "0", "0", "0"], ["0.0005", "-472.43516984502224", "4883.899137776818", "-4411.463967931796"]]);
});

test("shared non-monotone X preserves the point order of every hysteresis curve", () => {
  const rows = table([
    { label: "A", points: [{ x: 3, y: 0 }, { x: -3, y: 7 }, { x: 3, y: 3 }] },
    { label: "B", points: [{ x: 3, y: 9 }, { x: -3, y: 8 }, { x: 3, y: 4 }] },
  ]);
  assert.deepEqual(rows.slice(1), [["3", "0", "9"], ["-3", "7", "8"], ["3", "3", "4"]]);
});

test("different X grids and lengths keep separate XY pairs without invented values", () => {
  const rows = table([
    { label: "A", points: [{ x: 0, y: -1 }, { x: 1, y: -2 }] },
    { label: "B", points: [{ x: 0, y: 10 }, { x: .5, y: 11 }, { x: 1, y: 12 }] },
  ], "Время, с", "Ток, А");
  assert.deepEqual(rows[0], ["1. A · X: Время, с", "1. A · Y: Ток, А", "2. B · X: Время, с", "2. B · Y: Ток, А"]);
  assert.deepEqual(rows.slice(1), [["0", "-1", "0", "10"], ["1", "-2", "0.5", "11"], ["", "", "1", "12"]]);
});

test("equal X values at different steps or times are not presented as a shared grid", () => {
  for (const changed of [{ step: 1, time: 0 }, { step: 0, time: .5 }]) {
    const rows = table([
      { label: "A", points: [{ x: 3, y: 5, step: 0, time: 0 }] },
      { label: "B", points: [{ x: 3, y: 7, ...changed }] },
    ]);
    assert.equal(rows[0].length, 4);
    assert.deepEqual(rows[1], ["3", "5", "3", "7"]);
  }
});

test("empty curves retain their columns; names cannot inject extra TSV rows or columns", () => {
  const rows = table([
    { label: "A\tB\r\nC", points: [] },
    { label: "D", points: [{ x: 0, y: 1e-12 }] },
  ], "X\tunit", "Y\nunit");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.length === 4));
  assert.equal(rows[0][0], "1. A B C · X: X unit");
  assert.deepEqual(rows[1], ["", "", "0", "1e-12"]);
  assert.deepEqual(table(), [["X", "Y"]]);
});

test("one curve keeps its name and zero, negative and full precision values", () => {
  const rows = table([{ label: "I1", points: [{ x: 0, y: 0 }, { x: .010000000474974513, y: -60438.091059589642 }] }], "t, с", "I, А");
  assert.deepEqual(rows, [["t, с", "1. I1 · I, А"], ["0", "0"], ["0.010000000474974513", "-60438.09105958964"]]);
});
