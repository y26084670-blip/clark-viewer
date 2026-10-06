import test from "node:test";
import assert from "node:assert/strict";
import { readResultRanges, resultCycleRange, resultRangeChannels } from "../src/services/results/resultRanges.js";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";

const ROOT = "HEADER/RANGES";
const dataset = (value, shape = []) => ({ value, shape });
function fixture(name = "JE") {
  const channels = resultRangeChannels(name), count = channels.length;
  const header = { columns: name === "Q" ? 1 : 3, arrCount: ["JE", "MH"].includes(name) ? 2 : 1,
    hasCoo: true, inds1: [1, 3], numbs: [2, 1] };
  const steps = [{ index: 0, key: "000000" }, { index: 1, key: "000001" }];
  const entries = new Map([[ROOT, {}]]);
  const set = (key, value, shape = []) => entries.set(`${ROOT}/${key}`, dataset(value, shape));
  for (const [key, value] of Object.entries(header)) entries.set(`HEADER/${key}`, dataset(
    key === "hasCoo" ? 1 : value, Array.isArray(value) ? [value.length] : []));
  set("schema_version", 1); set("quantity_definition_version", 1);
  set("state", "complete"); set("run_id", "fixture-run");
  set("data_revision", 3n); set("indexed_revision", 3n);
  set("object_kind", ["HS", "AS"].includes(name) ? "regions" : ["HV", "AV"].includes(name) ? "virtual" : "elements");
  set("object_ids", new BigInt64Array([1n, 8n]), [2]);
  set("channel_ids", channels.map(c => c.id), [count]);
  set("channel_units", channels.map(c => c.unit), [count]);
  set("step_ids", new BigInt64Array([0n, 1n]), [2]);
  set("times", new Float64Array([0, 0.25]), [2]);
  set("time_step", 0.25); set("last_step", 1);
  const minimum = new Float64Array(count * 2), maximum = new Float64Array(count * 2);
  const valid = new BigInt64Array(count * 2), invalid = new BigInt64Array(count * 2);
  for (let object = 0; object < 2; object++) for (let c = 0; c < count; c++) {
    minimum[object * count + c] = channels[c].id.endsWith(".norm") ? 1 : -2;
    maximum[object * count + c] = object ? 7 : 3;
    valid[object * count + c] = BigInt(header.numbs[object] * steps.length);
  }
  if (name === "JE") {
    minimum.set([0, -2, 0, 1, -4, -2, 0, 2, -0.004, -7, 0, 0, 5, NaN, NaN, NaN, NaN, NaN]);
    maximum.set([3, 1, 0, 3, 4, 2, 0, 4, 0.012, -5, 0, 0, 7, NaN, NaN, NaN, NaN, NaN]);
    valid.fill(0n, 13);
  }
  set("global/min", minimum, [2, count]); set("global/max", maximum, [2, count]);
  set("global/valid_count", valid, [2, count]); set("global/invalid_count", invalid, [2, count]);
  const stride = 3 + header.columns * header.arrCount;
  let fieldReads = 0;
  for (const step of steps) {
    const values = new Float32Array(3 * stride).fill(step.index + 10);
    entries.set(step.key, { shape: [3, stride], get value() { fieldReads++; throw new Error("Full field read forbidden at metadata time"); },
      slice(ranges) { const [start, end, every] = ranges[0]; const out = [];
        for (let row = start; row < end; row += every) out.push(...values.subarray(row * stride, (row + 1) * stride));
        return new Float32Array(out); } });
  }
  const handle = { get: key => entries.get(key), keys: () => ["HEADER", ...steps.map(s => s.key)], close() {} };
  return { name, header, steps, entries, handle, set, minimum, maximum, valid, invalid,
    fieldReads: () => fieldReads, read() { return readResultRanges(handle, { name, header, steps }); } };
}

test("complete global ranges use model IDs, components, norms and signed products independently", () => {
  const f = fixture(), ranges = f.read();
  assert.equal(ranges.available, true);
  const one = resultCycleRange(ranges, "J", [1]);
  assert.deepEqual([one.minimum, one.maximum, one.unit, one.stepCount], [1, 3, "A/mm^2", 2]);
  assert.deepEqual(resultCycleRange(ranges, "J", [1, 8]), resultCycleRange(ranges, "J", [8, 1, 8]));
  assert.equal(resultCycleRange(ranges, "J", [1, 8]).maximum, 7);
  assert.equal(resultCycleRange(ranges, "J", [8], { component: 0 }).minimum, -7);
  assert.equal(resultCycleRange(ranges, "J", [1], { component: "1" }).minimum, -2);
  assert.equal(resultCycleRange(ranges, "JEdot", [1, 8]).minimum, -0.004);
  assert.equal(resultCycleRange(ranges, "JEdot", [1]).maximum, 0.012);
  assert.equal(resultCycleRange(ranges, "E", [8]).state, "empty");
  assert.equal(resultCycleRange(ranges, "J", []).state, "empty");
  assert.equal(resultCycleRange(ranges, "J", [99]).state, "missing");
  assert.equal(resultCycleRange(ranges, "J", [1], { component: "bad" }).available, false);
  assert.deepEqual(structuredClone(ranges), ranges);
});

test("all saved families have explicit display channels/units, with no second mu0 conversion", () => {
  for (const family of ["MH", "JE", "HS", "AS", "HV", "AV", "Q"]) {
    const f = fixture(family);
    assert.equal(f.read().available, true, family);
  }
  for (const [family, key] of [["HS", "Bs"], ["HV", "Bv"]]) {
    const f = fixture(family), b = 4 * Math.PI * 1e-7 * 1000;
    f.minimum[3] = f.maximum[3] = b;
    const range = resultCycleRange(f.read(), key, [1]);
    assert.equal(range.minimum, b); assert.equal(range.maximum, b); assert.equal(range.unit, "T");
  }
  const f = fixture("AS"), a = 4 * Math.PI * 1e-7;
  f.minimum[3] = f.maximum[3] = a;
  assert.equal(resultCycleRange(f.read(), "As", [1]).maximum, a);
  assert.equal(resultCycleRange(f.read(), "As", [1]).unit, "T*m");
  assert.deepEqual(resultRangeChannels("PSI"), []);
});

test("partial/stale/building/unsupported indexes cannot silently serve a full-cycle scale", () => {
  for (const state of ["building", "stale"]) {
    const f = fixture(); f.set("state", state);
    assert.equal(f.read().available, false); assert.equal(f.read().state, state);
  }
  const f = fixture(); f.set("state", "partial");
  assert.equal(resultCycleRange(f.read(), "J", [1]).available, false);
  assert.equal(resultCycleRange(f.read(), "J", [1], { allowPartial: true }).state, "partial");
  f.set("data_revision", 4n); assert.equal(f.read().state, "stale");
  f.set("schema_version", 2); assert.equal(f.read().state, "unsupported");
});

test("missing/invalid optional ranges do not block ordinary HDF5 reading", () => {
  for (const mode of ["missing", "invalid", "complete"]) {
    const f = fixture();
    if (mode === "missing") f.entries.delete(ROOT);
    if (mode === "invalid") f.set("channel_units", Array(9).fill("T"), [9]);
    const reader = new Hdf5ResultFile(f.name, f.handle);
    assert.equal(reader.metadata.ranges.state, mode);
    assert.equal(reader.metadata.ranges.available, mode === "complete");
    assert.equal(reader.metadata.steps.length, 2);
    assert.equal(reader.read({ step: 1, start: 0, count: 3 }).values[0], 11);
    assert.equal(f.fieldReads(), 0);
  }
});

test("malformed axes, types, IDs, channels, completeness, generations and counts are rejected", () => {
  const cases = [
    f => f.set("global/min", f.minimum, [9, 2]),
    f => f.set("global/min", new Float32Array(f.minimum), [2, 9]),
    f => f.set("object_ids", [1, 1], [2]),
    f => f.set("object_ids", [1, -8], [2]),
    f => f.set("object_kind", "regions"),
    f => f.set("channel_ids", Array(9).fill("J.norm"), [9]),
    f => f.set("last_step", 2),
    f => f.set("step_ids", [0, 0], [2]),
    f => f.set("step_ids", [0, 2], [2]),
    f => f.set("times", [0, 99], [2]),
    f => f.set("time_step", NaN),
    f => f.set("data_revision", 9007199254740993n),
    f => f.set("run_id", " "),
    f => { f.valid[0] = 3n; },
    f => { f.invalid[0] = -1n; },
    f => { f.minimum[0] = 99; },
    f => { f.maximum[0] = Infinity; },
    f => { f.minimum[3] = -1; },
    f => { f.minimum[13] = 0; },
  ];
  for (const [i, mutate] of cases.entries()) {
    const f = fixture(); mutate(f);
    assert.equal(f.read().available, false, `malformed case ${i}`);
    assert.equal(f.read().state, "invalid", `malformed case ${i}`);
  }
});

test("invalid values refuse only the affected channel/selection; empty ranges are not physical zeros", () => {
  const f = fixture(); f.invalid[0] = 1n; f.valid[0] = 3n;
  const ranges = f.read();
  assert.equal(ranges.available, true);
  assert.equal(resultCycleRange(ranges, "J", [1], { component: "x" }).state, "invalid");
  assert.equal(resultCycleRange(ranges, "J", [8], { component: "x" }).available, true);
  assert.equal(resultCycleRange(ranges, "E", [8]).state, "empty");
  f.set("state", "partial"); f.set("step_ids", [], [0]); f.set("times", [], [0]);
  f.minimum.fill(NaN); f.maximum.fill(NaN); f.valid.fill(0n); f.invalid.fill(0n);
  assert.equal(f.read().available, true);
  assert.equal(resultCycleRange(f.read(), "J", [1], { allowPartial: true }).state, "empty");
});

test("metadata reads each global dataset value only once and never accesses by-step/full fields", () => {
  const f = fixture(), calls = new Map();
  for (const path of ["min", "max", "valid_count", "invalid_count"]) {
    const key = `${ROOT}/global/${path}`, original = f.entries.get(key);
    f.entries.set(key, { shape: original.shape, get value() {
      calls.set(key, (calls.get(key) ?? 0) + 1); return original.value;
    } });
  }
  assert.equal(f.read().available, true);
  assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
  assert.equal(f.fieldReads(), 0);
});
