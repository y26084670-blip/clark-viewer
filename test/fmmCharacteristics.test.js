import test from "node:test";
import assert from "node:assert/strict";
import { parseFmmCharacteristic, characteristicCurve, fmmAxis, isFmm, isAnisotropic, loadFmmCharacteristic } from "../src/services/results/fmmCharacteristics.js";
import { workingPointSeries } from "../src/services/results/resultPlots.js";
import { buildGeometryTimeModel } from "../src/services/visualization/geometryTimeModel.js";

const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-12, `${actual} != ${expected}`));
const base = { id: 1, recordIndex: 0, name: "ФММ", targ: 0, model: 0, xapName: "Сталь", vkan: [0,0,0], dp: [[1],[1],[1]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0, symVi: [[0],[0],[0]], symR0: [[0],[0],[0]] };

test("FMM reads actual column-major rows, units unchanged; malformed tables rejected", () => {
  const points = parseFmmCharacteristic(JSON.stringify({ tabl: [0,1,2,3,4,5,6,7,8,9,10,11, 0,10,20,30,40,50,60,70,80,90,100,110] }));
  assert.deepEqual(points[4], { x: 4, y: 40 });
  assert.deepEqual(points.at(-1), { x:11,y:110 });
  assert.equal(isFmm(base), true);
  assert.equal(isFmm({ ...base, model: 2 }), false);
  assert.equal(isFmm({ ...base, targ: 1 }), false);
  for (const tabl of [[0,1,2], [0,0,10,20], [1,0,10,20], [0,1,NaN,10]]) {
    assert.throws(() => parseFmmCharacteristic(JSON.stringify({ tabl })));
  }
});

test("Negative characteristic branch follows solver threshold and anisotropy", () => {
  const p = [{x:0,y:0},{x:2,y:5},{x:4,y:7}];
  assert.deepEqual(characteristicCurve(p, true).points, [{x:-4,y:-7},{x:-2,y:-5},...p]);
  assert.equal(characteristicCurve(p, false).reflected, false);
  assert.equal(characteristicCurve([{x:0,y:2},...p.slice(1)], true).reflected, false);
  assert.equal(characteristicCurve([{x:.001,y:-.001},...p.slice(1)], true).reflected, false);
});

test("Original first H/M point uses solver REAL epsilon, including Float32 rounding", () => {
  for (const doubleFloat of [false, true]) {
    const epsilon = doubleFloat ? Number.EPSILON : 2 ** -23;
    const above = epsilon + 2 ** (doubleFloat ? -104 : -46);
    const origin = [{ x: -epsilon, y: epsilon }, { x: 1, y: 2 }];
    assert.equal(isAnisotropic(base, origin, doubleFloat), false);
    assert.equal(characteristicCurve(origin, true, doubleFloat).reflected, true);
    for (const first of [{ x: above, y: 0 }, { x: 0, y: -above }]) {
      const points = [first, origin[1]];
      assert.equal(isAnisotropic(base, points, doubleFloat), true);
      assert.equal(characteristicCurve(points, true, doubleFloat).reflected, false);
      assert.deepEqual(characteristicCurve(points, true, doubleFloat).points, points);
    }
    assert.equal(isAnisotropic({ ...base, vkan: [[0],[0],[0]] }, origin, doubleFloat), false);
    assert.equal(isAnisotropic({ ...base, vkan: [Number.MIN_VALUE,0,0] }, origin, doubleFloat), true);
  }
  const singleEpsilon = 2 ** -23;
  const rounded = [{ x: singleEpsilon * (1 + Number.EPSILON), y: 0 }, { x: 1, y: 2 }];
  assert.ok(rounded[0].x > singleEpsilon);
  assert.equal(isAnisotropic(base, rounded, false), false);
  assert.equal(characteristicCurve(rounded, true, false).reflected, true);
});

test("Zero and both 180-degree anisotropy orientations preserve signed H and M", () => {
  const characteristic = [{ x: -4, y: -1 }, { x: 0, y: 7 }];
  const original = structuredClone(characteristic);
  for (const doubleFloat of [false, true]) for (const angle of [0, 180, -180]) {
    const direction = angle === 0 ? 1 : -1;
    const record = { ...base, vkan: [0,angle,0], dp: [[1],[1],[2]] };
    const ArrayType = doubleFloat ? Float64Array : Float32Array;
    const frame = { stride: 9, count: 2, values: new ArrayType([
      11,12,13, direction*3,0,0, direction*-2,0,0,
      21,22,23, direction*-4,0,0, direction*-1,0,0,
    ]) };
    const saved = frame.values.slice();
    assert.equal(isAnisotropic(record, characteristic, doubleFloat), true);
    const series = workingPointSeries(frame, record, record, { characteristic, doubleFloat });
    close(series.points.map(p => p.x), [-2,-1]);
    close(series.points.map(p => p.y), [3,-4]);
    assert.match(series.tooltip(series.points[0]).join(" "), /H=-2; M=3/);
    assert.equal(series.showLine, false);
    assert.equal(characteristicCurve(characteristic, true, doubleFloat).reflected, false);
    assert.deepEqual(frame.values, saved);
  }
  assert.deepEqual(characteristic, original);
});

test("Task precision selects projection or modulus at the epsilon boundary", () => {
  const frame = { stride: 9, count: 1, values: new Float64Array([0,0,0, -3,4,0, -2,1,0]) };
  const origin = [{ x: 0, y: 0 }, { x: 1, y: 2 }];
  const nearOrigin = [{ x: 0, y: 1e-8 }, origin[1]];
  for (const doubleFloat of [false, true]) {
    const isotropic = workingPointSeries(frame, base, base, { characteristic: origin, doubleFloat });
    close(isotropic.points.map(p => p.x), [Math.hypot(-2,1)]);
    close(isotropic.points.map(p => p.y), [5]);
    const near = workingPointSeries(frame, base, base, { characteristic: nearOrigin, doubleFloat });
    close(near.points.map(p => p.x), [doubleFloat ? -2 : Math.hypot(-2,1)]);
    close(near.points.map(p => p.y), [doubleFloat ? -3 : 5]);
  }
});

test("Table anisotropy at zero material angles projects onto the moving local X axis", () => {
  const task = { general: { countTimeSteps: 2, timeStep: 1 }, elements: [{ ...base, indMove: 1 }], regions: [] };
  const moves = [{ angle: [[0,0,0,0],[2,0,0,180]], position: [[0,0,0,0],[2,0,0,0]] }];
  const projected = buildGeometryTimeModel(task, moves, 1).model.elements[0];
  const frame = { stride: 9, count: 1, values: new Float64Array([0,0,0, 0,3,0, 0,-2,0]) };
  const characteristic = [{ x: -4, y: -1 }, { x: 0, y: 7 }];
  const series = workingPointSeries(frame, task.elements[0], projected, { characteristic, doubleFloat: true });
  close(series.points.map(p => p.x), [-2]);
  close(series.points.map(p => p.y), [3]);
});

test("Anisotropy axis uses Euler angles, local auto rotation and current motion", () => {
  const record = { ...base, vkan: [0,0,90], symVi: [[0],[0],[90]], symYl: 90, symLs: 2 };
  close(fmmAxis(record, 0), [-1,0,0]);
  close(fmmAxis(record, 1), [0,0,1]);
  close(fmmAxis({ ...record, auto: false }, 1), [-1,0,0]);
  assert.equal(isAnisotropic({ ...base, vkan: [360,0,0] }), true);
  const task = { general: { countTimeSteps: 2, timeStep: 1 }, elements: [{ ...base, vkan: [0,0,90], indMove: 1 }], regions: [] };
  const moves = [{ angle: [[0,0,0,0],[2,0,0,180]], position: [[0,0,0,0],[2,0,0,0]] }];
  const projected = buildGeometryTimeModel(task, moves, 1);
  close(fmmAxis(projected.model.elements[0]), [-1,0,0]);
});

test("All working points are scatter; anisotropy excludes transverse H and exposes saved node indices", () => {
  const record = { ...base, dp: [[1],[1],[2]], vkan: [0,0,90] };
  const frame = { stride: 9, count: 2, values: new Float64Array([11,12,13, 0,3,0, 4,2,0, 21,22,23, 0,-5,0, 6,-4,0]) };
  const series = workingPointSeries(frame, record);
  close(series.points.map(p => p.x), [2,-4]);
  close(series.points.map(p => p.y), [3,-5]);
  assert.equal(series.showLine, false);
  assert.equal(series.points.length, 2);
  const tip = series.tooltip(series.points[1]).join("\n");
  assert.match(tip, /XYZ = \(21, 22, 23\) мм/);
  assert.match(tip, /i1=1; i2=1; i3=2; LS=1; AS=1; PS=1/);
  const isotropic = workingPointSeries(frame, { ...record, vkan: [0,0,0] });
  close(isotropic.points.map(p => p.x), [Math.hypot(4,2),Math.hypot(6,-4)]);
  assert.throws(() => workingPointSeries({ ...frame, every: 2 }, record), /не совпадает/);
});

test("Local characteristics are cached by exact name and isolated per task", async () => {
  let reads = 0;
  const task = { handle: { async getDirectoryHandle(name) {
    assert.equal(name, "input3XX");
    return { async getDirectoryHandle(name) { assert.equal(name, "xapLibFMM"); return {
      async getFileHandle(name) { reads++; if (name === "Нет.txt") throw new Error("Не найден файл");
        return { async getFile() { return { async text() { return JSON.stringify({ tabl: [0,1,0,name === "Сталь.txt" ? 10 : 20] }); } }; } };
      }
    }; } };
  } } };
  const [a,b,c] = await Promise.all([loadFmmCharacteristic(task,"Сталь"),loadFmmCharacteristic(task,"Сталь"),loadFmmCharacteristic(task,"Медь")]);
  assert.equal(reads,2); assert.equal(a,b); assert.equal(c[1].y,20);
  await assert.rejects(loadFmmCharacteristic(task,"Нет"));
  assert.equal((await loadFmmCharacteristic(task,"Сталь"))[1].y,10);
  await loadFmmCharacteristic({ handle:task.handle },"Сталь");
  assert.equal(reads,4);
  for (const name of ["../Сталь","x:y","x\\y"]) await assert.rejects(loadFmmCharacteristic(task,name));
});
