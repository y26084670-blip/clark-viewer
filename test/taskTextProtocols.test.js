import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { decodeHeader } from "../src/services/results/resultLayout.js";
import { elementLayout, regionLayout } from "../src/services/results/resultMappings.js";
import { createTextProtocols, deleteTextProtocols, listExistingTextProtocols, planTextProtocols, protocolHeader, protocolNumber,
  protocolRow, protocolTimestamp, textProtocolWriteAccess, TEXT_PROTOCOLS, vtspProtocolRow } from "../src/services/taskTextProtocols.js";

const names = TEXT_PROTOCOLS.map(p => p.name);
const record = { id: 1, recordIndex: 0, targ: 0, model: 0, rv: 1, xapName: "", dp: [[2], [1], [1]],
  symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const metadata = { JE: { header: decodeHeader({ columns: 3, arrCount: 2, hasCoo: 1, inds1: [1], numbs: [2] }),
  steps: [{ index: 0 }, { index: 2 }], pointCount: 2 } };
const task = { general: { countTimeSteps: 2, timeStep: .5 }, elements: [record], regions: [], moves: [] };
const rows = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [11, 12, 13, -1, -2, -3, 0, 0, 0]];
const missing = () => new DOMException("not found", "NotFoundError");
function directory(initial = {}, { failWrite = false } = {}) {
  const files = new Map(Object.entries(initial)), writes = [], deleted = [];
  return { files, writes, deleted, async getFileHandle(name, { create } = {}) {
    if (!files.has(name)) { if (!create) throw missing(); files.set(name, ""); }
    return { async createWritable() {
      let text = "";
      return { async write(value) { if (failWrite) throw new Error("disk full"); writes.push(value.length); text += value; },
        async close() { files.set(name, text); }, async abort() {} };
    } };
  }, async removeEntry(name) { if (!files.has(name)) throw missing(); deleted.push(name); files.delete(name); } };
}
const reader = { async read({ start, count, step }) { return { stride: 9, count,
  values: new Float64Array(rows.slice(start, start + count).flat().map((v, i) => i % 9 < 3 ? v + step : v)) }; } };

test("Printf-compatible E/f/G formats: rounding, signs, exponents, subnormals and wide numbers", () => {
  const cases = [
    [0, " 0.000000E+00", "     0.000000", "             0"],
    [-0, "-0.000000E+00", "    -0.000000", "            -0"],
    [1.25, " 1.250000E+00", "     1.250000", "          1.25"],
    [999999.5, " 9.999995E+05", "999999.500000", "       1000000"],
    [1e-5, " 1.000000E-05", "     0.000010", "         1E-05"],
    [1e-4, " 1.000000E-04", "     0.000100", "        0.0001"],
  ];
  for (const [value, ...expected] of cases) assert.deepEqual(["E", "f", "G"].map(kind => protocolNumber(value, kind)), expected.map((v, i) => v.padStart(i === 2 ? 14 : 13)));
  assert.equal(protocolNumber(123456.5, "G").trim(), "123456");
  assert.equal(protocolNumber(123457.5, "G").trim(), "123458");
  assert.equal(protocolNumber(Number.MIN_VALUE).trim(), "4.940656E-324");
  assert.equal(protocolNumber(1e21, "f").trim(), "1000000000000000000000.000000");
});

test("Headers retain legacy labels, whitespace and one header per file", () => {
  assert.equal(protocolTimestamp(new Date(2026, 9, 30, 12, 3, 4, 5)), ' Date: 2026.10.30 Time: 12:03\'04.005"');
  assert.equal(protocolHeader("JE", 2, false), "\n iDTK    2\n");
  assert.equal(protocolHeader("HS", 2, false), "\n iDTK=    2\n");
  assert.equal(protocolHeader("VTSP", 2, false), " iDTK    2\n");
  assert.match(protocolHeader("VTSP", 0, true, 17), /^17\n.*B\/mu0.*Jc.*RO\n iDTK    0     Электрофизическое состояние ВТСП\n$/);
});

test("Source and observation indices preserve saved symmetry ordering and native units", () => {
  const source = { ...record, id: 4, dp: [[2], [1], [1]], symLs: 2, symAs: 3, symPs: 2 };
  const object = { record: source, layout: elementLayout(source) }, data = new Float64Array(rows[0]);
  const line = protocolRow("JE", object, 23, 23, data);
  assert.deepEqual(line.trim().split(/\s+/).map(Number), [4, 2, 1, 1, 2, 3, 2, ...rows[0]]);
  assert.equal(protocolRow("JE", { ...object, record: { ...source, targ: 2 } }, 23, 23, data).trim().split(/\s+/).length, 13);
  const region = { id: 2, dp: [[2], [3]], symLs: 2 };
  assert.deepEqual(protocolRow("HS", { record: region, layout: regionLayout(region) }, 11, 23, data.subarray(0, 6)).trim().split(/\s+/).map(Number),
    [24, 2, 2, 2, 3, 1, 2, 3, 4, 5, 6]);
  const virtual = { ...source, indAmp: 1, dp: [[2], [3], [4]] };
  assert.deepEqual(protocolRow("HV", { record: virtual, layout: elementLayout(virtual, true) }, 287, 300, data.subarray(0, 6)).trim().split(/\s+/).map(Number),
    [301, 4, 4, 3, 2, 2, 3, 2, 1, 2, 3, 4, 5, 6]);
});

for (const Type of [Float32Array, Float64Array]) test(`VTSP uses the material axis and vector norms: ${Type.name}`, () => {
  const object = { record, layout: elementLayout(record) };
  const mh = new Type([1, 2, 3, 20, 3, 0, 10, 7, 0]), je = new Type([1, 2, 3, 0, 3, 4, 0, .3, .4]);
  const line = vtspProtocolRow(object, 0, mh, je, [0, 1, 0], { JC0: 100, j_HC0: 100, JCa: 1, JCb: 1 });
  const values = line.trim().split(/\s+/).map(Number).slice(10);
  assert.deepEqual(values.slice(0, 6), [7, 3, 10, 90, .5, 5]);
  assert.ok(Math.abs(values[6] - .1) < 1e-7);
  je.fill(0, 3);
  assert.equal(Number(vtspProtocolRow(object, 0, mh, je, [1, 0, 0], { JC0: 100, j_HC0: 100, JCa: 1, JCb: 1 }).trim().split(/\s+/).at(-1)), 0);
});

test("Input/HDF5 mismatch and incomplete time history are rejected before writing", () => {
  assert.throws(() => planTextProtocols(task, {}), /нет сохранённых/);
  assert.throws(() => planTextProtocols({ ...task, elements: [{ ...record, dp: [[3], [1], [1]] }] }, metadata), /сетка/);
  assert.throws(() => planTextProtocols(task, { JE: { ...metadata.JE, steps: [{ index: 3 }] } }), /шаги/);
  const hts = { ...task, elements: [{ ...record, model: 2, xapName: "HTS" }] };
  assert.throws(() => planTextProtocols(hts, { ...metadata, MH: { ...metadata.JE, steps: [{ index: 0 }] } }), /шаги MH и JE/);
});

test("Create streams every saved step, replaces old files, and preserves HDF5/integral protocols", async () => {
  const output = directory({ "JE.h5": "binary", "prot-QKV.txt": "losses", "prot-source-J.txt": "obsolete", "prot-source-M.txt": "obsolete" });
  const requests = [];
  const tracking = { read: request => { requests.push(request); return reader.read(request); } };
  const result = await createTextProtocols(task, metadata, tracking, output, { chunkSize: 1 });
  assert.deepEqual(result.created, ["prot-source-J.txt"]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.count === 1));
  const text = output.files.get(result.created[0]);
  assert.equal((text.match(/Плотность токов/g) || []).length, 1);
  assert.deepEqual([...text.matchAll(/iDTK\s+(\d+)/g)].map(m => Number(m[1])), [0, 2]);
  const lines = text.split("\n").filter(l => /^\s+1\s+\d/.test(l));
  assert.equal(lines.length, 4);
  assert.equal(Number(lines[2].trim().split(/\s+/)[7]), 3); // coordinates at step 2, from HDF5
  assert.equal(output.files.get("JE.h5"), "binary");
  assert.equal(output.files.get("prot-QKV.txt"), "losses");
  assert.equal(output.files.has("prot-source-M.txt"), false);
  await createTextProtocols(task, metadata, reader, output, { chunkSize: 1 });
  assert.equal(output.files.get(result.created[0]), text);
});

test("Read error, cancellation and write failure preserve previous files and remove empty placeholders", async () => {
  for (const existing of [false, true]) for (const failure of ["read", "cancel", "write"]) {
    const output = directory(existing ? { "prot-source-J.txt": "old" } : {}, { failWrite: failure === "write" });
    let calls = 0;
    const failing = { read: async r => { if (failure === "read" && ++calls === 2) throw new Error("read failed"); return reader.read(r); } };
    await assert.rejects(createTextProtocols(task, metadata, failing, output, { chunkSize: 1, check() {
      if (failure === "cancel" && ++calls > 6) throw new DOMException("cancel", "AbortError");
    } }));
    assert.equal(output.files.has("prot-source-J.txt"), existing);
    if (existing) assert.equal(output.files.get("prot-source-J.txt"), "old");
  }
});

test("Delete is limited to the accepted five names and works without input or HDF5", async () => {
  const output = directory(Object.fromEntries([...names, "JE.h5", "prot-force.txt", "prot-psi.txt", "prot-QKV.txt", "prot-iter.txt"].map(n => [n, "saved"])));
  const handle = { getDirectoryHandle: async name => { assert.equal(name, "output3XX"); return output; } };
  assert.deepEqual((await deleteTextProtocols(handle)).deleted, names);
  assert.deepEqual([...output.files.keys()], ["JE.h5", "prot-force.txt", "prot-psi.txt", "prot-QKV.txt", "prot-iter.txt"]);
  assert.deepEqual((await deleteTextProtocols(handle)).deleted, []);
  assert.deepEqual(await deleteTextProtocols({ getDirectoryHandle: async () => { throw missing(); } }), { deleted: [] });
});

test("Write permission is requested only by an explicit action", async () => {
  const modes = [];
  await assert.rejects(textProtocolWriteAccess({ kind: "directory", requestPermission: async mode => { modes.push(mode); return "denied"; } }), /разрешения/);
  assert.deepEqual(modes, [{ mode: "readwrite" }]);
});

for (const Type of [Float32Array, Float64Array]) test(`Real HDF5 ${Type.name}: full rows and sparse saved steps`, async () => {
  await h5wasm.ready;
  const dir = await mkdtemp(join(tmpdir(), "clark-text-protocols-"));
  let file;
  try {
    const path = join(dir, "JE.h5"), h5 = new h5wasm.File(path, "w"), header = h5.create_group("HEADER");
    for (const [name, data] of Object.entries({ columns: [3n], arrCount: [2n], hasCoo: [1n], inds1: [1n], numbs: [2n] })) {
      header.create_dataset({ name, data: new BigInt64Array(data) });
    }
    for (const step of [0, 2]) h5.create_dataset({ name: String(step).padStart(6, "0"), data: new Type(rows.flat()), shape: [2, 9] });
    h5.close(); file = new Hdf5ResultFile("JE", new h5wasm.File(path, "r"));
    const output = directory();
    await createTextProtocols(task, { JE: file.metadata }, { read: r => file.read(r) }, output);
    assert.equal((output.files.get("prot-source-J.txt").match(/iDTK/g) || []).length, 2);
    assert.match(output.files.get("prot-source-J.txt"), /-3\.000000E\+00/);
  } finally { file?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("presence checks only the selected task's accepted files, including empty files, without reading or writing", async () => {
  for (const name of names) {
    const output = directory({ [name]: "", "prot-force.txt": "keep", "JE.h5": "binary" });
    const selected = { async getDirectoryHandle(folder, options) { assert.equal(folder, "output3XX"); assert.equal(options, undefined); return output; } };
    assert.deepEqual(await listExistingTextProtocols(selected), [name]);
    assert.deepEqual(output.writes, []); assert.deepEqual(output.deleted, []);
  }
  assert.deepEqual(await listExistingTextProtocols({ getDirectoryHandle: async () => directory({ "prot-force.txt": "keep", "JE.h5": "binary" }) }), []);
  assert.deepEqual(await listExistingTextProtocols({ getDirectoryHandle: async () => { throw missing(); } }), []);
});

test("presence does not confuse permission errors, directories or cancellation with absent protocols", async () => {
  for (const name of ["NotAllowedError", "TypeMismatchError"]) {
    const failure = new DOMException("blocked", name);
    await assert.rejects(listExistingTextProtocols({ getDirectoryHandle: async () => { throw failure; } }), { name });
    await assert.rejects(listExistingTextProtocols({ getDirectoryHandle: async () => ({ getFileHandle: async () => { throw failure; } }) }), { name });
  }
  await assert.rejects(listExistingTextProtocols({}, { signal: AbortSignal.abort() }), { name: "AbortError" });
});
