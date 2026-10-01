import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { decodeHeader } from "../src/services/results/resultLayout.js";
import { sourceRecords, expectedPointCount } from "../src/services/results/resultMappings.js";
import { lossIntegrationWeights } from "../src/services/results/resultLosses.js";
import { readLossHistory, lossHistorySeries } from "../src/services/results/resultHistories.js";

const prism = (options = {}) => ({ id: 1, targ: 0, rv: 2, geoType: 2,
  geo: [[10, 20, 30]], dp: [[2], [1], [1]],
  symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0, ...options });
const input = elements => ({ elements, general: { timeStep: .25, mirrorSymmetryX: -1, mirrorSymmetryY: -1 } });
function metadata(task) {
  const numbs = sourceRecords(task, "Q").map(record => expectedPointCount(record, "Q"));
  let pointCount = 0;
  const inds1 = numbs.map(count => { const start = pointCount + 1; pointCount += count; return start; });
  return { pointCount, header: decodeHeader({ columns: 1, arrCount: 1, hasCoo: 1, numbs, inds1 }),
    steps: [{ key: "000000", index: 0 }, { key: "000002", index: 2 }] };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test("Loss weights integrate elementary volumes and convert MW/m³ × mm³ to W once", () => {
  const task = input([prism()]);
  assert.deepEqual([...lossIntegrationWeights(task, metadata(task))], [3, 3]);
  // Усечённая пирамида: разные объёмы слоёв 55.5 и 28.5 мм³.
  task.elements = [prism({ geoType: 3, geo: [[6, 4, 6], [2, 3, 0]] })];
  const weights = lossIntegrationWeights(task, metadata(task));
  close(weights[0], .0555); close(weights[1], .0285);
  close(weights[0] + 10 * weights[1], .3405);
  // Совмещённые вершины пирамиды допустимы: не вводим ограничения
  // старого геометрического валидатора, отсутствующие в историческом контракте.
  task.elements = [prism({ geoType: 0, geo: [[0, 4, 0], [6, 2, 3], [0, 4, 6], [6, 2, 3],
    [0, 0, 0], [6, 2, 3], [0, 0, 6], [6, 2, 3]] })];
  const pyramid = lossIntegrationWeights(task, metadata(task));
  close(pyramid[0], .042); close(pyramid[1], .006);
});

test("Explicit, reduced and alternating symmetry images have the same total losses", () => {
  for (const symKya of [0, 1, -1]) for (const symKyp of [0, 1, -1]) {
    const task = input([prism({ symLs: 2, symAs: 3, symPs: 4, symKya, symKyp })]);
    const weights = lossIntegrationWeights(task, metadata(task));
    close(weights.reduce((a, b) => a + b, 0), 144);
    task.general.mirrorSymmetryX = 0; task.general.mirrorSymmetryY = 1;
    close(lossIntegrationWeights(task, metadata(task)).reduce((a, b) => a + b, 0), 576);
  }
});

test("Prescribed-current rows retain their offsets and do not contribute to conduction losses", () => {
  const task = input([prism({ targ: 2 }), prism({ id: 2, rv: 0 }), prism({ id: 3, model: 2 })]);
  assert.deepEqual([...lossIntegrationWeights(task, metadata(task))], [0, 0, 3, 3]);
  const damaged = metadata(task); damaged.pointCount++;
  assert.throws(() => lossIntegrationWeights(task, damaged), /число строк/);
  task.elements[2].geo = [[NaN, 1, 1]];
  assert.throws(() => lossIntegrationWeights(task, metadata(task)), /геометрия ШГ №3/);
});

async function qFile(Type, task, densities, body) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "e3d-loss-test-"));
  const meta = metadata(task); let handle;
  try {
    const path = join(directory, "Q.h5");
    handle = new h5wasm.File(path, "w");
    const header = handle.create_group("HEADER");
    for (const key of ["columns", "arrCount", "hasCoo"]) {
      header.create_dataset({ name: key, data: new BigInt64Array([1n]), shape: [] });
    }
    for (const key of ["inds1", "numbs"]) {
      header.create_dataset({ name: key, data: BigInt64Array.from(meta.header[key], BigInt) });
    }
    for (const [index, values] of densities) {
      // Координаты намеренно велики; их нельзя включать в интеграл Q.
      const data = new Type(values.flatMap(value => [10000, 20000, 30000, value]));
      handle.create_dataset({ name: String(index).padStart(6, "0"), data, shape: [values.length, 4] });
    }
    handle.close(); handle = new h5wasm.File(path, "r");
    const file = new Hdf5ResultFile("Q", handle);
    const ready = { ...task, metadata: { Q: file.metadata },
      reader: { integralHistory: request => {
        assert.equal(request.name, "Q"); return file.integralHistory(request);
      } } };
    await body(ready, file);
  } finally { handle?.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const Type of [Float32Array, Float64Array]) {
  test(`Real Q ${Type.name}: total instantaneous power uses saved steps and works without FM`, async () => {
    const task = input([prism({ targ: 2 }), prism({ id: 2 }), prism({ id: 3, model: 2 })]);
    await qFile(Type, task, [[0, [999, 999, 0, 0, 0, 0]], [2, [999, 999, 1, 2, 3, 4]],
      [12, [999, 999, 2, 4, 6, 8]]], async task => {
      const history = await readLossHistory(task);
      assert.deepEqual([...history.values], [0, 30, 60]);
      assert.deepEqual(lossHistorySeries(history, .25).points,
        [{ x: 0, y: 0, step: 0 }, { x: .5, y: 30, step: 2 }, { x: 3, y: 60, step: 12 }]);
      assert.match(lossHistorySeries(history, .25).tooltip({ x: .5, y: 30, step: 2 }).join(" "), /30 Вт/);
    });
  });
}

test("Q integration reads bounded chunks and produces only one scalar per time step", async () => {
  const count = 16385, task = input([prism({ dp: [[count], [1], [1]] })]);
  await qFile(Float64Array, task, [[0, Array(count).fill(2)], [2, Array(count).fill(3)]], async (task, file) => {
    const ranges = [], read = file.read.bind(file);
    file.read = request => { ranges.push([request.start, request.count]); return read(request); };
    const history = file.integralHistory({ weights: new Float64Array(count).fill(.001), offset: 3 });
    close(history.values[0], count * .002); close(history.values[1], count * .003);
    assert.deepEqual(ranges, [[0, 16384], [16384, 1], [0, 16384], [16384, 1]]);
    assert.equal(history.stride, 1); assert.equal(history.values.length, 2);
  });
});

test("Missing, empty, nonfinite and mismatched Q histories have explicit errors", async () => {
  const task = input([prism()]);
  await assert.rejects(readLossHistory(task), /Q.h5 отсутствует/);
  await qFile(Float64Array, task, [], async task => assert.rejects(readLossHistory(task), /нет сохранённых шагов/));
  await qFile(Float64Array, task, [[0, [NaN, 1]]], async task => assert.rejects(readLossHistory(task), /нечисловые или бесконечные/));
  await qFile(Float64Array, task, [[0, [1, 2]]], async (task, file) => {
    assert.throws(() => file.integralHistory({ weights: new Float64Array([1]), offset: 3 }), /веса/);
    assert.throws(() => file.integralHistory({ weights: new Float64Array([1, NaN]), offset: 3 }), /веса/);
    assert.throws(() => file.integralHistory({ weights: new Float64Array([1, 1]), offset: 4 }), /веса/);
    task.reader.integralHistory = () => ({ values: new Float64Array([3]), stride: 1, steps: [1] });
    await assert.rejects(readLossHistory(task), /не совпадают с метаданными/);
  });
});
