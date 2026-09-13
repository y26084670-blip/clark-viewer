import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { HISTORY_QUANTITIES, measurementCoils, readFluxHistories, readForceMomentHistory,
  fluxHistorySeries, forceMomentHistorySeries } from "../src/services/results/resultHistories.js";

// Julia resWrite stores PSI as NCOIL×1 and FM as 1×6 on disk. Neither
// family has coordinates or per-geometry ranges in its HEADER.
async function fixture(name, Type, body, options = {}) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "clark-history-test-"));
  const path = join(directory, `${name}.h5`);
  const stride = name === "FM" ? 6 : 1;
  let handle;
  try {
    handle = new h5wasm.File(path, "w");
    const header = handle.create_group("HEADER");
    for (const [key, value] of Object.entries({ columns: name === "FM" ? 3n : 1n,
      arrCount: name === "FM" ? 2n : 1n, hasCoo: 0n })) {
      header.create_dataset({ name: key, data: new BigInt64Array([value]), shape: [] });
    }
    for (const key of ["inds1", "numbs"]) header.create_dataset({ name: key, data: new BigInt64Array() });
    const steps = options.steps ?? [0, 2, 12].map(step => ({ key: String(step).padStart(6, "0"),
      values: name === "FM" ? [step, -3, 4, 5, 12, step] : [step * 10 + 1, -(step * 10 + 2), 0, step * 10 + 4] }));
    for (const step of steps) {
      const values = new Type(step.values);
      handle.create_dataset({ name: step.key, data: values, shape: step.shape ?? [values.length / stride, stride] });
    }
    handle.close(); handle = new h5wasm.File(path, "r");
    await body(handle);
  } finally { handle?.close(); await rm(directory, { recursive: true, force: true }); }
}

function input() {
  return { general: { countTimeSteps: 12, timeStep: .25 },
    elements: [{ id: 1, targ: 3, name: "Верх", indCoil: 2, wCoil: 100 },
      { id: 2, targ: 3, name: "Низ", indCoil: -2, wCoil: 100 },
      { id: 3, targ: 2, name: "Источник тока", indCoil: 99 },
      { id: 4, targ: 3, indCoil: 0 }],
    regions: [{ id: 1, name: "Контур", indCoil: -4, wCoil: 25 }, { id: 2 }] };
}

function taskWithFile(file, task = input()) {
  return { ...task, metadata: { [file.name]: file.metadata }, reader: {
    history: async ({ name, point }) => {
      assert.equal(name, file.name);
      return file.history({ point });
    },
  } };
}

test("Measurement coils group signed KV/TK indices, preserve gaps and ignore source KV", () => {
  const task = input();
  task.regions.push({ id: 3, name: "Третий участок", indCoil: 2 });
  const coils = measurementCoils(task);
  assert.deepEqual(coils.map(record => [record.id, record.name]), [[2, "Катушка №2"], [4, "Катушка №4"]]);
  assert.deepEqual(coils[0].members.map(member => [member.schemaId, member.indCoil]),
    [["elements", 2], ["elements", -2], ["regions", 2]]);
  assert.equal(coils[0].members[0].wCoil, 100);
  assert.deepEqual(measurementCoils(null), []);
  assert.throws(() => measurementCoils({ regions: [{ id: 1, indCoil: 1.5 }] }), /номер.*катушки/);
});

for (const Type of [Float32Array, Float64Array]) {
  test(`Real PSI ${Type.name}: gaps map by coil number and linkage stays in Wb`, async () => {
    await fixture("PSI", Type, async handle => {
      const file = new Hdf5ResultFile("PSI", handle);
      assert.equal(file.metadata.pointCount, 4);
      assert.deepEqual(file.header.inds1, []);
      assert.deepEqual(file.header.numbs, []);
      const task = taskWithFile(file);
      const histories = await readFluxHistories({ task, selected: [4, 2] });
      assert.deepEqual(histories.map(item => item.record.id), [2, 4]);
      assert.deepEqual(Array.from(histories[0].history.values), [-2, -22, -122]);
      const series = fluxHistorySeries(histories[1], task.general.timeStep);
      assert.deepEqual(series.points, [{ x: 0, y: 4, step: 0 }, { x: .5, y: 24, step: 2 }, { x: 3, y: 124, step: 12 }]);
      assert.match(series.tooltip(series.points[0]).join(" "), /Потокосцепление = 4 Вб/);
      assert.deepEqual(await readFluxHistories({ task, selected: [] }), []);
    });
  });

  test(`Real FM ${Type.name}: saved vector order, component signs and physical units`, async () => {
    await fixture("FM", Type, async handle => {
      const file = new Hdf5ResultFile("FM", handle);
      assert.equal(file.metadata.pointCount, 1);
      assert.deepEqual(file.header.inds1, []);
      const task = taskWithFile(file);
      const history = await readForceMomentHistory(task);
      assert.deepEqual(history.steps, [0, 2, 12]);
      assert.deepEqual(Array.from(history.values.slice(0, 6)), [0, -3, 4, 5, 12, 0]);
      assert.equal(forceMomentHistorySeries(history, .25).points[0].y, 5);
      assert.equal(forceMomentHistorySeries(history, .25, "moment").points[0].y, 13);
      for (const [quantity, expected] of [["force", [0, -3, 4]], ["moment", [5, 12, 0]]]) {
        for (let axis = 0; axis < 3; axis++) {
          const series = forceMomentHistorySeries(history, .25, quantity, String(axis));
          assert.equal(series.points[0].y, expected[axis]);
          assert.deepEqual(series.points.map(point => point.x), [0, .5, 3]);
        }
      }
      assert.match(forceMomentHistorySeries(history, .25, "moment", "1").tooltip({ x: 0, y: 12, step: 0 }).join(" "), /12 Н·м/);
      assert.equal(HISTORY_QUANTITIES.force.unit, "Н");
      assert.equal(HISTORY_QUANTITIES.flux.unit, "Вб");
    });
  });
}

test("Static zero histories produce visible single points at time zero", async () => {
  await fixture("PSI", Float64Array, async handle => {
    const task = taskWithFile(new Hdf5ResultFile("PSI", handle), { ...input(), general: { countTimeSteps: 0, timeStep: 0 } });
    const histories = await readFluxHistories({ task, selected: [2] });
    assert.deepEqual(fluxHistorySeries(histories[0], 0).points, [{ x: 0, y: 0, step: 0 }]);
  }, { steps: [{ key: "000000", values: [0, 0, 0, 0] }] });
  await fixture("FM", Float32Array, async handle => {
    const task = taskWithFile(new Hdf5ResultFile("FM", handle), { general: { timeStep: 0 } });
    const history = await readForceMomentHistory(task);
    assert.deepEqual(forceMomentHistorySeries(history, 0, "moment").points, [{ x: 0, y: 0, step: 0 }]);
  }, { steps: [{ key: "000000", values: [0, 0, 0, 0, 0, 0] }] });
});

test("Real files with HEADER only remain empty; missing and damaged files have clear errors", async () => {
  for (const name of ["PSI", "FM"]) {
    const read = task => name === "PSI" ? readFluxHistories({ task, selected: [2] }) : readForceMomentHistory(task);
    await assert.rejects(read(input()), /отсутствует/);
    await assert.rejects(read({ ...input(), metadata: { [name]: { error: "Неверный HEADER" } } }), /Неверный HEADER/);
    await fixture(name, Float64Array, async handle => {
      const file = new Hdf5ResultFile(name, handle);
      assert.equal(file.metadata.pointCount, null);
      await assert.rejects(read(taskWithFile(file)), /нет сохранённых шагов/);
    }, { steps: [] });
  }
});

test("Real HDF5 rejects transposed shapes and changing row counts without HEADER ranges", async () => {
  await fixture("PSI", Float32Array, handle => assert.throws(() => new Hdf5ResultFile("PSI", handle), /форма/),
    { steps: [{ key: "000000", values: [1, 2, 3, 4], shape: [1, 4] }] });
  await fixture("FM", Float64Array, handle => assert.throws(() => new Hdf5ResultFile("FM", handle), /форма/),
    { steps: [{ key: "000000", values: [1, 2, 3, 4, 5, 6], shape: [6, 1] }] });
  await fixture("PSI", Float64Array, handle => assert.throws(() => new Hdf5ResultFile("PSI", handle), /число строк меняется/),
    { steps: [{ key: "000000", values: [1, 2, 3, 4] }, { key: "000001", values: [1, 2, 3] }] });
});

test("PSI row count must match largest coil index; FM must have one total row", async () => {
  for (const values of [[0, 0, 0], [0, 0, 0, 0, 0], []]) {
    await fixture("PSI", Float64Array, async handle => {
      const task = taskWithFile(new Hdf5ResultFile("PSI", handle));
      await assert.rejects(readFluxHistories({ task, selected: [2] }), /ожидается 4 строк/);
    }, { steps: [{ key: "000000", values }] });
  }
  await fixture("FM", Float64Array, async handle => {
    const task = taskWithFile(new Hdf5ResultFile("FM", handle));
    await assert.rejects(readForceMomentHistory(task), /одна строка/);
  }, { steps: [{ key: "000000", values: Array(12).fill(0) }] });
});

test("Nonfinite saved data and mismatched history metadata are rejected before plotting", async () => {
  await fixture("PSI", Float64Array, async handle => {
    const task = taskWithFile(new Hdf5ResultFile("PSI", handle));
    await assert.rejects(readFluxHistories({ task, selected: [2] }), /нечисловые или бесконечные/);
  }, { steps: [{ key: "000000", values: [0, NaN, 0, 0] }] });
  await fixture("FM", Float64Array, async handle => {
    const file = new Hdf5ResultFile("FM", handle);
    const task = taskWithFile(file);
    task.metadata.FM.steps = [{ key: "000000", index: 0 }, { key: "000001", index: 1 }, { key: "000012", index: 12 }];
    await assert.rejects(readForceMomentHistory(task), /не совпадают с метаданными/);
  });
});

test("Selecting many coil histories enforces the combined memory limit before worker reads", async () => {
  let readCount = 0;
  const task = { general: { timeStep: .1 },
    elements: Array.from({ length: 1025 }, (_, i) => ({ id: i + 1, targ: 3, indCoil: i + 1 })),
    metadata: { PSI: { pointCount: 1025, steps: Array.from({ length: 8192 }, (_, index) => ({ index })) } },
    reader: { history: async () => { readCount++; throw new Error("Unexpected worker request"); } } };
  await assert.rejects(readFluxHistories({ task, selected: task.elements.map(record => record.id) }), /64 МБ/);
  assert.equal(readCount, 0);
});

test("History conversion validates dimensions, time indices, values and component choices", () => {
  const record = { id: 1, name: "Катушка №1" };
  const history = { stride: 1, steps: [0, 2], values: new Float64Array([0, 1]) };
  for (const timeStep of [-1, NaN, Infinity, 0, Number.MAX_VALUE]) {
    assert.throws(() => fluxHistorySeries({ record, history }, timeStep), /врем|Врем/);
  }
  for (const steps of [[1, 0], [0, 0], [-1, 0], [0, 1.5], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => fluxHistorySeries({ record, history: { ...history, steps } }, 1), /номера шагов/);
  }
  assert.throws(() => fluxHistorySeries({ record, history: { ...history, values: [0] } }, 1), /формат/);
  assert.throws(() => fluxHistorySeries({ record, history: { ...history, values: [0, Infinity] } }, 1), /нечисловые или бесконечные/);
  const force = { stride: 6, steps: [0], values: new Float64Array(6) };
  assert.throws(() => forceMomentHistorySeries(force, 0, "flux"), /силу или момент/);
  assert.throws(() => forceMomentHistorySeries(force, 0, "force", "3"), /модуль или компоненту/);
  force.values.fill(Number.MAX_VALUE);
  assert.throws(() => forceMomentHistorySeries(force, 0), /модуль вектора/);
});
