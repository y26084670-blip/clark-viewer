import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { appendResultRanges } from "../src/services/results/resultRangeBackfillCore.js";
import { backfillTaskResultRanges } from "../src/services/results/resultRangeBackfill.js";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";

async function oldFile(name, Type, body, { steps = [0, 1] } = {}) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "clark-range-backfill-"));
  const path = join(directory, `${name}.h5`);
  let handle;
  try {
    handle = new h5wasm.File(path, "w");
    const header = handle.create_group("HEADER");
    const family = name === "MH" || name === "JE" ? [3, 2] : name === "Q" ? [1, 1] : [3, 1];
    for (const [key, value] of Object.entries({ columns: family[0], arrCount: family[1], hasCoo: 1 })) {
      header.create_dataset({ name: key, data: new BigInt64Array([BigInt(value)]), shape: [] });
    }
    header.create_dataset({ name: "inds1", data: new BigInt64Array([1n, 2n]) });
    header.create_dataset({ name: "numbs", data: new BigInt64Array([1n, 1n]) });
    const stride = 3 + family[0] * family[1];
    for (const step of steps) {
      const rows = [];
      for (let object = 0; object < 2; object++) {
        const base = 10 * (step + 1) + object;
        if (name === "Q") rows.push(object, 0, step, base);
        else if (name === "MH" || name === "JE") rows.push(object, 0, step, base, -base, 0, 2 * base, 0, -base);
        else rows.push(object, 0, step, base, -base, 0);
      }
      handle.create_dataset({ name: String(step).padStart(6, "0"), data: new Type(rows), shape: [2, stride] });
    }
    handle.close(); handle = null;
    await body(path);
  } finally {
    handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const Type of [Float32Array, Float64Array]) test(`backfill writes valid HEADER/RANGES v1 without changing old MH frames (${Type.name})`, async () => {
  await oldFile("MH", Type, async path => {
    let handle = new h5wasm.File(path, "a");
    const before = Array.from(handle.get("000001").value);
    const applicability = [
      true,true,true,true, true,true,true,true, true,
      true,true,true,true, false,false,false,false, false,
    ];
    const result = appendResultRanges(handle, { name: "MH", objectIds: [1, 8], applicability,
      objectKind: "elements", timeStep: .25, lastStep: 1, runId: "backfill-test" });
    assert.deepEqual(result, { steps: 2, objects: 2, channels: 9 });
    handle.close();

    handle = new h5wasm.File(path, "r");
    const file = new Hdf5ResultFile("MH", handle);
    const ranges = file.metadata.ranges;
    assert.equal(ranges.available, true); assert.equal(ranges.state, "complete");
    assert.equal(ranges.runId, "backfill-test");
    assert.deepEqual(ranges.objectIds, [1, 8]);
    assert.deepEqual(ranges.stepIds, [0, 1]);
    assert.deepEqual(ranges.times, [0, .25]);
    assert.deepEqual(Array.from(handle.get("000001").value), before);
    const c = ranges.channelIds.length;
    assert.equal(ranges.validCount[c + ranges.channelIds.indexOf("H.norm")], 0);
    assert.ok(Number.isNaN(ranges.minimum[c + ranges.channelIds.indexOf("H.norm")]));
    file.close();
  });
});

test("backfill applies AS display conversion once and refuses an existing or incomplete index", async () => {
  await oldFile("AS", Float64Array, async path => {
    let handle = new h5wasm.File(path, "a");
    appendResultRanges(handle, { name: "AS", objectIds: [1, 2], applicability: Array(8).fill(true),
      objectKind: "regions", timeStep: .5, lastStep: 1, runId: "as-test" });
    assert.throws(() => appendResultRanges(handle, { name: "AS", objectIds: [1, 2], applicability: Array(8).fill(true),
      objectKind: "regions", timeStep: .5, lastStep: 1, runId: "again" }), /уже содержит/);
    handle.close();
    handle = new h5wasm.File(path, "r");
    const ranges = new Hdf5ResultFile("AS", handle).metadata.ranges;
    const mu0 = 4 * Math.PI * 1e-7;
    const normIndex = ranges.channelIds.indexOf("As.norm");
    assert.ok(Math.abs(ranges.maximum[normIndex] - Math.hypot(20, -20, 0) * mu0) < 1e-18);
    handle.close();
  });
  await oldFile("Q", Float64Array, async path => {
    const handle = new h5wasm.File(path, "a");
    assert.throws(() => appendResultRanges(handle, { name: "Q", objectIds: [1, 2], applicability: [true, true],
      objectKind: "elements", timeStep: .5, lastStep: 2, runId: "bad" }), /неполные данные/);
    handle.close();
  }, { steps: [0, 2] });
});

test("nonfinite old values are counted and make only the affected global channel unusable", async () => {
  await oldFile("Q", Float64Array, async path => {
    let handle = new h5wasm.File(path, "a");
    const frame = handle.get("000001");
    frame.write_slice([[0, 1], []], new Float64Array([0, 0, 1, NaN]));
    appendResultRanges(handle, { name: "Q", objectIds: [1, 2], applicability: [true, true],
      objectKind: "elements", timeStep: 1, lastStep: 1, runId: "nan-test" });
    handle.close();
    handle = new h5wasm.File(path, "r");
    const ranges = new Hdf5ResultFile("Q", handle).metadata.ranges;
    assert.equal(ranges.available, true);
    assert.equal(ranges.invalidCount[0], 1);
    assert.equal(ranges.validCount[0], 1);
    handle.close();
  });
});


function backfillTask(metadata = {}, files = {}) {
  return {
    general: { countTimeSteps: 2, timeStep: .1 },
    metadata,
    files,
    elements: [], regions: [],
    handle: {
      async requestPermission() { return "granted"; },
      async getDirectoryHandle() { return { async getFileHandle(name) { return { name }; } }; },
    },
  };
}

test("empty or missing result families are normal and do not force a per-file report", async () => {
  const ready = { header: { numbs: [1] }, steps: [{index:0},{index:1},{index:2}],
    ranges: { available: true, state: "complete", runId: "run" } };
  const empty = { header: { numbs: [] }, steps: [], ranges: { available: false, state: "missing" } };
  const task = backfillTask({ MH: ready, HV: empty, AV: empty }, { MH: {}, HV: {}, AV: {} });
  assert.deepEqual(await backfillTaskResultRanges(task), [
    { state: "all-ready", message: "Файлы уже содержат данные минимакса" },
  ]);
});

test("incomplete data and unusable existing minmax use short user diagnostics", async () => {
  const incomplete = { header: { numbs: [1] }, steps: [{index:0},{index:2}],
    ranges: { available: false, state: "missing" } };
  const invalid = { header: { numbs: [1] }, steps: [{index:0},{index:1},{index:2}],
    ranges: { available: false, state: "invalid", reason: "technical detail" } };
  const task = backfillTask({ HV: incomplete, JE: invalid }, { HV: {}, JE: {} });
  assert.deepEqual(await backfillTaskResultRanges(task), [
    { name: "HV", state: "problem", message: "неполные данные" },
    { name: "JE", state: "problem", message: "минмакс присутствует, но не используется: данные повреждены" },
  ]);
});
