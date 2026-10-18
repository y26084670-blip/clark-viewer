import assert from "node:assert/strict";
import test from "node:test";
import { readConditionsContext, parseConditionsMpiRanks, prepareConditionsRequest, readConditionsResult, waitForConditionsResult } from "../src/services/taskConditionsService.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const files = new Map(), writes = [], permissions = [];
  const absent = () => { throw new DOMException("missing", "NotFoundError"); };
  const fs = { permission: "granted", relative: ["project", "loaded-task"], output: false };
  const handle = key => ({ async getFile() { return new File([files.get(key)], key); }, async createWritable() {
    let value;
    return { async write(next) { value = next; }, async close() { files.set(key, value); writes.push(key); }, async abort() {} };
  } });
  const root = { resolve: async target => target === task.handle ? fs.relative : null,
    requestPermission(options) { permissions.push(options); return Promise.resolve(fs.permission); },
    async getFileHandle(name, options) { if (!files.has(name) && !options?.create) absent(); return handle(name); } };
  const task = { handle: { async getDirectoryHandle(name) {
    if (name !== "output3XX" || !fs.output) absent();
    return { async getFileHandle(name) { if (!files.has(`output3XX/${name}`)) absent(); return handle(`output3XX/${name}`); } };
  } }, workspace: { rootHandle: root } };
  const binding = { schemaVersion: 1, workspaceId, bindingState: "bound", conditionsVersion: 1 };
  const setBinding = () => files.set("clark.workspace.json", JSON.stringify(binding)); setBinding();
  return { task, root, files, writes, permissions, fs, binding, setBinding,
    result(request, value = {}) { files.set("clark.conditions-result.json", JSON.stringify({ schemaVersion: 1, workspaceId,
      requestId: request.requestId, state: "completed", path: "output3XX/conditions.json", ...value })); } };
}

test("context is read-only and works without OM or any existing calculation results", async () => {
  const f = fixture();
  assert.equal((await readConditionsContext(f.task)).taskPath, "project/loaded-task");
  assert.equal((await readConditionsContext(f.task)).exists, false);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.permissions, []);
});

test("context requires the loaded task inside a bound workspace with a compatible helper", async () => {
  await assert.rejects(readConditionsContext(null), /Загрузите/);
  const f = fixture();
  for (const relative of [null, [], ["..", "other"], ["task."], ["C:\\task"]]) {
    f.fs.relative = relative; await assert.rejects(readConditionsContext(f.task), /вне базового/);
  }
  f.fs.relative = ["task"];
  f.binding.conditionsVersion = undefined; f.setBinding();
  await assert.rejects(readConditionsContext(f.task), /Обновите локальный/);
  f.files.delete("clark.workspace.json"); await assert.rejects(readConditionsContext(f.task), /Связать/);
});

test("MPI count is explicit, bounded and never inferred from solver defaults", () => {
  for (const value of ["", 0, -1, "1.5", "1e2", NaN, Infinity, 2147483648, "12x"]) assert.throws(() => parseConditionsMpiRanks(value));
  for (const value of [1, "12", 2147483647]) assert.equal(parseConditionsMpiRanks(value), Number(value));
});

test("explicit command requests permission synchronously and writes only a one-use proof for the loaded task", async () => {
  const f = fixture();
  const operation = prepareConditionsRequest(f.task, 7, false);
  assert.deepEqual(f.permissions, [{ mode: "readwrite" }]);
  const request = await operation;
  assert.deepEqual(f.writes, ["clark.conditions-request.json"]);
  const proof = JSON.parse(f.files.get(f.writes[0]));
  assert.equal(proof.taskPath, "project/loaded-task"); assert.equal(proof.mpiRanks, 7); assert.equal(proof.replace, false);
  assert.match(request.uri, /^clark:\/\/conditions\?workspace=/);
  assert.equal(proof.requestId, request.requestId);
  assert.equal(f.files.has("conditions.json"), false); assert.equal(f.files.has("run.json"), false);
});

test("permission denial, cancellation and invalid count write no proof", async () => {
  const f = fixture(); f.fs.permission = "denied";
  await assert.rejects(prepareConditionsRequest(f.task, 2, false), /Разрешите запись/);
  f.fs.permission = "granted";
  const abort = new AbortController(); abort.abort();
  await assert.rejects(prepareConditionsRequest(f.task, 2, false, { signal: abort.signal }), { name: "AbortError" });
  await assert.rejects(prepareConditionsRequest(f.task, 0, false), /целое число/);
  assert.deepEqual(f.writes, []);
});

test("existing conditions require explicit replacement; input and result files are untouched", async () => {
  const f = fixture(); f.fs.output = true; f.files.set("output3XX/conditions.json", "original");
  await assert.rejects(prepareConditionsRequest(f.task, 2, false), /разрешение замены/);
  await prepareConditionsRequest(f.task, 2, true);
  assert.equal(f.files.get("output3XX/conditions.json"), "original");
  assert.equal(JSON.parse(f.files.get("clark.conditions-request.json")).replace, true);
});

test("native acknowledgements must match workspace and request and report actual errors", async () => {
  const f = fixture(), request = await prepareConditionsRequest(f.task, 2, false);
  assert.equal(await readConditionsResult(request), null);
  f.result(request, { requestId: "another" }); assert.equal(await readConditionsResult(request), null);
  f.result(request, { workspaceId: "another" }); assert.equal(await readConditionsResult(request), null);
  f.result(request, { state: "error", message: "File exists" }); await assert.rejects(readConditionsResult(request), /File exists/);
  f.result(request); assert.equal((await readConditionsResult(request)).state, "completed");
});

test("waiting times out honestly and aborts on leaving the loaded task", async () => {
  const f = fixture(), request = await prepareConditionsRequest(f.task, 2, false);
  await assert.rejects(waitForConditionsResult(request, { timeoutMs: 1, intervalMs: 2 }), /Нет подтверждения/);
  const abort = new AbortController();
  const operation = waitForConditionsResult(request, { signal: abort.signal });
  abort.abort(); await assert.rejects(operation, { name: "AbortError" });
  f.result(request); assert.equal((await waitForConditionsResult(request)).state, "completed");
});
