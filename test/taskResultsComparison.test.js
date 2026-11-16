import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import h5wasm from "h5wasm/node";
import {
  compareH5Results, compareResultFilePairs, compareTaskResults, formatComparisonReport, formatFileComparison,
  listComparisonTasks, parseFinalTimings, readComparisonTask, resultFilePairs,
} from "../src/services/taskResultsComparisonService.js";

const schemas = { MH: [3, 2, 1], JE: [3, 2, 1], AS: [3, 1, 1], FM: [3, 2, 0], PSI: [1, 1, 0], Q: [1, 1, 1], JE_work: [1, 1, 1] };
async function fixtures(body) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "clark-comparison-"));
  const handles = [];
  function make(name, rows, { Type = Float64Array, steps = [0, 2], timeStep, shape } = {}) {
    const path = join(directory, `${handles.length}.h5`), file = new h5wasm.File(path, "w");
    const [columns, arrCount, hasCoo] = schemas[name];
    const header = file.create_group("HEADER");
    for (const [key, value] of Object.entries({ columns, arrCount, hasCoo })) {
      header.create_dataset({ name: key, data: BigInt64Array.of(BigInt(value)), shape: [] });
    }
    if (timeStep !== undefined) header.create_group("RANGES").create_dataset({ name: "time_step", data: timeStep });
    const stride = hasCoo * 3 + columns * arrCount;
    for (const step of steps) {
      const data = typeof rows === "function" ? rows(step) : rows;
      file.create_dataset({ name: String(step).padStart(6, "0"), data: new Type(data.flat()), shape: shape ?? [data.length, stride] });
    }
    file.close();
    const result = new h5wasm.File(path, "r"); handles.push(result);
    return result;
  }
  try { await body(make, directory); }
  finally { handles.forEach(handle => handle.close()); await rm(directory, { recursive: true, force: true }); }
}

for (const Type of [Float32Array, Float64Array]) {
  test(`real H5 ${Type.name}: separate relative J/E norms include every component, row and saved step, exclude coordinates`, async () => fixtures(make => {
    const a = make("JE", [[0, 0, 0, 1, 2, 2, 2, 2, 2], [1, 2, 3, 1, 2, 2, 2, 2, 2]], { Type });
    const b = make("JE", step => Array.from({ length: 2 }, () => [999, -999, Infinity,
      ...(step === 0 ? [2, 4, 4] : [5, 2, 2]), 12, 12, 12]), { Type });
    const result = compareH5Results("JE.h5", a, b, { chunkRows: 1 });
    assert.equal(result.records, 4);
    assert.deepEqual(result.groups.map(g => [g.label, g.components]), [["J", 12], ["E", 12]]);
    assert.ok(Math.abs(result.groups[0].relative - Math.sqrt(25 / 18)) < 1e-12);
    assert.equal(result.groups[1].relative, 5);
    assert.deepEqual(compareH5Results("JE.h5", a, b, { chunkRows: 100 }), result);
  }));
}

test("different precision can compare directly; equal physical results give zero", async () => fixtures(make => {
  const a = make("MH", [[1, 2, 3, 1, 2, 3, 4, 5, 6]], { Type: Float32Array });
  const b = make("MH", [[9, 9, 9, 1, 2, 3, 4, 5, 6]], { Type: Float64Array });
  assert.deepEqual(compareH5Results("mh.H5", a, b).groups.map(g => [g.label, g.relative]), [["M", 0], ["H", 0]]);
}));

test("force and moment are normalized separately against task 1", async () => fixtures(make => {
  const a = make("FM", [[1, 1, 1, 2, 2, 2]]), b = make("FM", [[2, 2, 2, 8, 8, 8]]);
  assert.deepEqual(compareH5Results("FM.h5", a, b).groups.map(g => [g.label, g.relative]), [["F", 1], ["момент", 3]]);
}));

test("relative vector potential does not depend on unit conversion; scalar quantities stay scalar", async () => fixtures(make => {
  const a = make("AS", [[0, 0, 0, 1, 1, 1]]), b = make("AS", [[0, 0, 0, 2, 2, 2]]);
  const result = compareH5Results("AS.h5", a, b).groups[0];
  assert.equal(result.relative, 1);
  assert.equal(result.unit, undefined);
  for (const name of ["PSI", "JE_work"]) {
    const coo = name === "PSI" ? [] : [1, 2, 3];
    const x = make(name, [[...coo, 1], [...coo, 3]]), y = make(name, [[...coo, 2], [...coo, 4]]);
    assert.ok(Math.abs(compareH5Results(`${name}.h5`, x, y).groups[0].relative - Math.sqrt(.2)) < 1e-15);
  }
}));

test("record mismatch is detected before numeric arrays are read", async () => fixtures(make => {
  const a = make("PSI", [[1]]), b = make("PSI", [[1], [2]]);
  const protect = file => ({ keys: () => file.keys(), get(key) {
    const dataset = file.get(key);
    return /^\d+$/.test(key) ? { shape: dataset.shape, slice() { assert.fail("numeric data were read"); } } : dataset;
  } });
  assert.match(compareH5Results("PSI.h5", protect(a), protect(b)).message, /число записей различается: 2 \/ 4/);
}));

test("equal total counts cannot hide different step numbers, point distribution or saved-step counts", async () => fixtures(make => {
  const a = make("PSI", [[1]], { steps: [0, 1], timeStep: .1 });
  const b = make("PSI", [[1]], { steps: [0, 2], timeStep: .1 });
  const c = make("PSI", step => step === 0 ? [[1], [1]] : [], { steps: [0, 1] });
  const d = make("PSI", [[1], [1]], { steps: [0] });
  assert.match(compareH5Results("PSI.h5", a, b).message, /номера шагов/);
  assert.match(compareH5Results("PSI.h5", a, c).message, /число записей по шагам/);
  assert.match(compareH5Results("PSI.h5", a, d).message, /число временных записей/);
}));

for (const [description, firstStep, secondStep, Type] of [
  ["REAL32/REAL64 rounding", Math.fround(.0002), .0002, Float32Array],
  ["REAL64 rounding", .1 + .2, .3, Float64Array],
  ["different time_step metadata", .1, .2, Float64Array],
]) {
  test(`matching saved steps compare despite ${description}`, async () => fixtures(make => {
    assert.notEqual(firstStep, secondStep);
    const a = make("PSI", [[1], [2]], { Type, timeStep: firstStep });
    const b = make("PSI", [[2], [4]], { timeStep: secondStep });
    const result = compareH5Results("PSI.h5", a, b);
    assert.equal(result.records, 4);
    assert.deepEqual(result.groups.map(g => [g.label, g.components, g.relative]), [["Ψ", 4, 1]]);
  }));
}

test("empty files, unsupported units and malformed layouts never produce a misleading zero", async () => fixtures(make => {
  const a = make("MH", [], { steps: [] }), b = make("MH", [], { steps: [] });
  assert.match(compareH5Results("MH.h5", a, b).message, /нет записей/);
  const c = make("PSI", [[1]]), d = make("PSI", [[2]]);
  assert.match(compareH5Results("unknown.h5", c, d).message, /неизвестны физические/);
  assert.match(compareH5Results("MH.h5", c, d).message, /структура колонок/);
  assert.throws(() => compareH5Results("PSI.h5", c, d, { chunkRows: 0 }), /размер/);
}));

test("relative norms preserve tiny/large values, avoid difference overflow and reject NaN", async () => fixtures(make => {
  for (const value of [1e-200, 1e200, Number.MIN_VALUE]) {
    const a = make("PSI", [[value]]), b = make("PSI", [[2 * value]]);
    assert.equal(compareH5Results("PSI.h5", a, b).groups[0].relative, 1);
  }
  const a = make("PSI", [[1e308]]), b = make("PSI", [[-1e308]]);
  assert.equal(compareH5Results("PSI.h5", a, b).groups[0].relative, 2);
  assert.throws(() => compareH5Results("PSI.h5", a, make("PSI", [[NaN]])), /нечисловые/);
}));

test("task 1 is the reference, so swapping tasks changes normalization", async () => fixtures(make => {
  const a = make("PSI", [[1], [2]]), b = make("PSI", [[2], [4]]);
  assert.equal(compareH5Results("PSI.h5", a, b).groups[0].relative, 1);
  assert.equal(compareH5Results("PSI.h5", b, a).groups[0].relative, .5);
}));

test("zero reference is explicit: two zero vectors give zero, a nonzero difference gives infinity", async () => fixtures(make => {
  const a = make("JE", [[0, 0, 0, 0, 0, 0, 2, 2, 2]]), b = make("JE", [[0, 0, 0, 1, 0, 0, 3, 3, 3]]);
  const result = compareH5Results("JE.h5", a, b);
  assert.equal(result.groups[0].relative, Infinity); assert.equal(result.groups[0].zeroReference, true);
  assert.equal(result.groups[1].relative, .5); assert.equal(result.groups[1].zeroReference, false);
  assert.equal(formatFileComparison("JE.h5", result), "JE.h5 — J: ∞ (норма задания 1 равна 0); E: 5.000000e-1");
  const zero = make("PSI", [[0]]);
  assert.equal(formatFileComparison("PSI.h5", compareH5Results("PSI.h5", zero, zero)), "PSI.h5 — Ψ: 0");
}));

test("all H5 filenames form a natural ordered union, including files present in one task only", () => {
  const pairs = resultFilePairs([{ name: "JE.h5" }, { name: "file10.h5" }], [{ name: "je.H5" }, { name: "file2.h5" }]);
  assert.deepEqual(pairs.map(p => [p.name, !!p.first, !!p.second]), [["file2.h5", false, true], ["file10.h5", true, false], ["JE.h5", true, true]]);
});

test("a bad file cannot prevent comparison of later files; every opened H5 is closed", async () => fixtures((make, directory) => {
  const left = make("PSI", [[1]]), right = make("PSI", [[2]]);
  let closed = 0;
  const wrap = file => ({ keys: () => file.keys(), get: key => file.get(key), close() { closed++; } });
  const first = [{ name: "bad.h5" }, { name: "only.h5" }, { name: "PSI.h5" }];
  const second = [{ name: "bad.h5" }, { name: "PSI.h5" }];
  const lines = compareResultFilePairs(first, second, (side, file) => {
    if (file.name === "bad.h5") throw new Error("повреждён");
    return wrap(side === 0 ? left : right);
  });
  assert.match(lines[0], /bad.h5 — ошибка: повреждён/);
  assert.match(lines[1], /only.h5 — есть только в задании 1/);
  assert.match(lines[2], /PSI.h5 — Ψ: 1.000000e\+0$/);
  assert.equal(closed, 2);
}));

test("timings come only from the last final block, never from intermediate steps", () => {
  const text = "Матрица (мин): 999\nИтого за расчет:\nПолное время (мин): 8\nМатрица (мин): 7\n"
    + "Итого за расчёт:\nПолное время (мин): 1,25\nМатрица (мин): 0.5\nРасчет источников (мин): 0.25\nРасчёт поля (мин): 0.2\n";
  assert.deepEqual(parseFinalTimings(text), [1.25, .5, .25, .2]);
  assert.deepEqual(parseFinalTimings("Матрица (мин): 999"), [null, null, null, null]);
  assert.deepEqual(parseFinalTimings("Итого за расчет:\nМатрица (мин): -2\nРасчет поля (мин): NaN"), [null, null, null, null]);
});

test("current solver totals without a heading are read after the numeric step table", () => {
  // solver/src/base/01_common.jl: ftiming_write_step and ftiming_write_totals.
  const text = "   idtk            время (с)  матрица (мин)  источники (мин)   поле (мин)\r\n"
    + "      0                  0.0         999.000           888.000      777.000\r\n\r\n"
    + "Полное время (мин): 1.044\r\nМатрица (мин):            0.506\r\nРасчет источников (мин): 0.205\r\nРасчет поля (мин): 0.311\r\n";
  assert.deepEqual(parseFinalTimings(text), [1.044, .506, .205, .311]);
});

test("mixed old/current timing blocks use the latest totals without borrowing earlier rows", () => {
  const old = "Итого за расчет:\nПолное время (мин): 4\nМатрица (мин): 3\nРасчет источников (мин): 2\nРасчет поля (мин): 1\n";
  const current = "Полное время (мин): 8\nМатрица (мин): 6\nРасчет источников (мин): 4\nРасчет поля (мин): 2\n";
  assert.deepEqual(parseFinalTimings(old + current), [8, 6, 4, 2]);
  assert.deepEqual(parseFinalTimings(current + old), [4, 3, 2, 1]);
  assert.deepEqual(parseFinalTimings(old + "\nИтого за расчет:\n"), [null, null, null, null]);
  assert.deepEqual(parseFinalTimings(old + "\nПолное время (мин): 0\n"), [0, null, null, null]);
});

const absent = () => new DOMException("missing", "NotFoundError");
function file(name, data) { return { name, kind: "file", async getFile() { return new File([data], name); } }; }
function directory(name, children = []) {
  return { name, kind: "directory", async *entries() { for (const child of children) yield [child.name, child]; },
    async getDirectoryHandle(name, options) { assert.equal(options, undefined); const found = children.find(c => c.name === name && c.kind === "directory"); if (!found) throw absent(); return found; },
    async getFileHandle(name, options) { assert.equal(options, undefined); const found = children.find(c => c.name === name && c.kind === "file"); if (!found) throw absent(); return found; } };
}
const task = (label = "Project / Task") => ({ label, handle: directory("Task", [directory("output3XX", [file("PSI.h5", "fixture"), file("timing.txt", "Полное время (мин): 1")])]) });

test("both selectors can enumerate tasks from every project in the current list, naturally sorted", async () => {
  const result = await listComparisonTasks([{ name: "Project10", handle: directory("Project10", [directory("Task10"), file("ignore", "")]) },
    { name: "Project2", handle: directory("Project2", [directory("Task2")]) }]);
  assert.deepEqual(result.tasks.map(t => t.key), ["Project2/Task2", "Project10/Task10"]);
});

test("task scanning is read-only, includes every H5 extension and handles missing output/timing", async () => {
  const result = await readComparisonTask(task());
  assert.deepEqual(result.files.map(f => f.name), ["PSI.h5"]); assert.deepEqual(result.timings, [1, null, null, null]);
  const empty = await readComparisonTask({ label: "empty", handle: directory("empty") });
  assert.deepEqual(empty.files, []); assert.deepEqual(empty.timings, [null, null, null, null]);
});

test("report contains separate dimensionless relative residuals and four timing rows", () => {
  const report = formatComparisonReport({ label: "a", timings: [1, 2, 3, 4] }, { label: "b", timings: [5, 6, null, 8] }, ["JE.h5 — J: 0; E: 1.000000e+0"]);
  assert.match(report, /Относительная невязка по норме задания 1; безразмерная/);
  assert.doesNotMatch(report, /А\/мм²|В\/м|Абсолютная СКН/);
  assert.match(report, /Итоговое время \(мин\):\n\tзадание 1\tзадание 2\nПолное:/);
  assert.match(report, /Полное:\t1\t5\nМатрицы:\t2\t6\nИсточники:\t3\tнет данных\nПоле:\t4\t8$/);
});

test("closing or changing the comparison terminates its worker and rejects the obsolete result", async () => {
  const controller = new AbortController(); let started, worker;
  const begun = new Promise(resolve => { started = resolve; });
  const result = compareTaskResults(task("a"), task("b"), { signal: controller.signal, workerFactory: () => (worker = {
    postMessage() { started(); }, terminate() { this.stopped = true; },
  }) });
  await begun; controller.abort();
  await assert.rejects(result, { name: "AbortError" }); assert.equal(worker.stopped, true); assert.equal(worker.onmessage, null);
});

test("successful worker report releases worker resources and uses final timings", async () => {
  let worker;
  const result = await compareTaskResults(task("a"), task("b"), { workerFactory: () => (worker = {
    postMessage() { queueMicrotask(() => this.onmessage({ data: { type: "complete", lines: ["PSI.h5 — Ψ: 0"] } })); },
    terminate() { this.stopped = true; },
  }) });
  assert.equal(worker.stopped, true); assert.match(result, /PSI.h5 — Ψ: 0/); assert.match(result, /Полное:\t1\t1/);
});
