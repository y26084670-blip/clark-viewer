import test from "node:test";
import assert from "node:assert/strict";
import { readTaskStatus, readTaskStatusEntry } from "../src/services/taskStatusService.js";

const fsError = name => Object.assign(new Error(name), { name });
function filesystem() {
  const calls = [];
  class Directory {
    constructor() { this.kind = "directory"; this.children = new Map(); this.errors = new Map(); }
    async lookup(name, options, kind) {
      calls.push({ name, options, kind });
      if (this.errors.has(name)) throw fsError(this.errors.get(name));
      const child = this.children.get(name);
      if (!child) throw fsError("NotFoundError");
      if (child.kind !== kind) throw fsError("TypeMismatchError");
      return child;
    }
    getDirectoryHandle(name, options) { return this.lookup(name, options, "directory"); }
    getFileHandle(name, options) { return this.lookup(name, options, "file"); }
  }
  const root = new Directory();
  const directory = path => path.split("/").filter(Boolean).reduce((parent, name) => {
    if (!parent.children.has(name)) parent.children.set(name, new Directory());
    return parent.children.get(name);
  }, root);
  const file = path => {
    const parts = path.split("/"), name = parts.pop();
    directory(parts.join("/")).children.set(name, { kind: "file" });
  };
  return { root, calls, directory, file };
}

test("all sixteen independent combinations, including solution without input", async () => {
  for (let mask = 0; mask < 16; mask++) {
    const fs = filesystem();
    if (mask & 1) fs.file("output3XX/_summary_out.txt");
    if (!(mask & 2)) fs.directory("input3XX");
    if (mask & 4) fs.directory("output3XX/demo");
    if (mask & 8) fs.directory("comparison");
    assert.deepEqual(await readTaskStatus(fs.root), {
      hasSolution: Boolean(mask & 1), missingInput: Boolean(mask & 2),
      hasGifs: Boolean(mask & 4), hasComparison: Boolean(mask & 8), omState: "none", errors: {},
    }, `mask ${mask}`);
    assert.ok(fs.calls.every(call => call.options?.create === false));
  }
});

test("comparison uses Viewer task-root path; empty demo and comparison directories count", async () => {
  const fs = filesystem();
  fs.directory("output3XX/comparasion");
  fs.directory("output3XX/comparison");
  fs.file("output3XX/summary_out.txt");
  assert.equal((await readTaskStatus(fs.root)).hasComparison, false);
  assert.equal((await readTaskStatus(fs.root)).hasSolution, false);
  fs.directory("comparison"); fs.directory("output3XX/demo");
  const result = await readTaskStatus(fs.root);
  assert.equal(result.hasComparison, true); assert.equal(result.hasGifs, true);
  assert.ok(fs.calls.every(call => !["comparasion", "summary_out.txt"].includes(call.name)));
});

test("wrong entry kinds do not count as the required file or directories", async () => {
  const fs = filesystem();
  fs.directory("output3XX/_summary_out.txt");
  fs.file("output3XX/demo"); fs.file("input3XX"); fs.file("comparison");
  assert.deepEqual(await readTaskStatus(fs.root), {
    hasSolution: false, missingInput: true, hasGifs: false, hasComparison: false, omState: "none", errors: {},
  });
});

test("permission and I/O errors stay unknown without masking unrelated indicators", async () => {
  for (const name of ["NotAllowedError", "SecurityError", "UnknownError"]) {
    const fs = filesystem();
    fs.root.errors.set("input3XX", name);
    fs.file("output3XX/_summary_out.txt"); fs.directory("comparison");
    const status = await readTaskStatus(fs.root);
    assert.equal(status.missingInput, null); assert.equal(status.errors.missingInput, name);
    assert.equal(status.hasSolution, true); assert.equal(status.hasComparison, true);
    fs.root.errors.set("output3XX", name);
    const failedOutput = await readTaskStatus(fs.root);
    assert.equal(failedOutput.hasSolution, null); assert.equal(failedOutput.hasGifs, null);
    assert.equal(failedOutput.errors.hasSolution, name); assert.equal(failedOutput.errors.hasGifs, name);
    assert.equal(failedOutput.hasComparison, true);
  }
});

test("successive reads reflect creation, removal and restored access", async () => {
  const fs = filesystem();
  assert.equal((await readTaskStatus(fs.root)).missingInput, true);
  fs.directory("input3XX"); fs.file("output3XX/_summary_out.txt");
  fs.directory("output3XX/demo"); fs.directory("comparison");
  assert.deepEqual(await readTaskStatus(fs.root), {
    hasSolution: true, missingInput: false, hasGifs: true, hasComparison: true, omState: "none", errors: {},
  });
  fs.root.errors.set("input3XX", "NotAllowedError");
  assert.equal((await readTaskStatus(fs.root)).missingInput, null);
  fs.root.errors.clear(); fs.root.children.delete("output3XX"); fs.root.children.delete("comparison");
  assert.deepEqual(await readTaskStatus(fs.root), {
    hasSolution: false, missingInput: false, hasGifs: false, hasComparison: false, omState: "none", errors: {},
  });
});

test("launcher paths are resolved afresh and missing paths differ from denied paths", async () => {
  const fs = filesystem();
  fs.directory("project/task/input3XX");
  const entry = { root: fs.root, path: "project\\task" };
  assert.equal((await readTaskStatusEntry(entry)).missingInput, false);
  fs.directory("project").children.delete("task");
  assert.equal((await readTaskStatusEntry(entry)).missingInput, true);
  fs.directory("project/task/comparison");
  assert.equal((await readTaskStatusEntry(entry)).hasComparison, true);
  fs.root.errors.set("project", "NotAllowedError");
  const status = await readTaskStatusEntry(entry);
  assert.equal(status.missingInput, null);
  assert.ok(Object.values(status.errors).every(message => message === "NotAllowedError"));
});

test("invalid launcher paths cannot escape the root or perform filesystem checks", async () => {
  const fs = filesystem();
  for (const path of ["../task", "p/../task", "/p/task", "C:/p/task", "p//task", "", "p/./task"]) {
    assert.equal((await readTaskStatusEntry({ root: fs.root, path })).missingInput, null);
  }
  assert.equal(fs.calls.length, 0);
});

test("aborted reads are discarded rather than reported as missing input", async () => {
  const fs = filesystem(), controller = new AbortController();
  controller.abort();
  await assert.rejects(readTaskStatus(fs.root, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.calls.length, 0);
});


test("OM status uses selector existence independently of the solution marker", async () => {
  for (const solved of [false, true]) {
    const fs = filesystem(); fs.directory("input3XX");
    if (solved) fs.file("output3XX/_summary_out.txt");
    assert.equal((await readTaskStatus(fs.root)).omState, "none");
    fs.file("input3XX/_om-client.json");
    assert.equal((await readTaskStatus(fs.root)).omState, "disabled");
    fs.directory("input3XX").children.delete("_om-client.json");
    fs.file("input3XX/om-client.json");
    const active = await readTaskStatus(fs.root);
    assert.equal(active.omState, "active"); assert.equal(active.hasSolution, solved);
    fs.file("input3XX/_om-client.json");
    const conflict = await readTaskStatus(fs.root);
    assert.equal(conflict.omState, "active"); assert.match(conflict.errors.omState, /Одновременно/);
  }
});

test("inaccessible OM selectors stay unknown and directories do not count as selectors", async () => {
  const fs = filesystem(), input = fs.directory("input3XX");
  fs.directory("input3XX/om-client.json");
  assert.equal((await readTaskStatus(fs.root)).omState, "none");
  input.errors.set("om-client.json", "NotAllowedError");
  const status = await readTaskStatus(fs.root);
  assert.equal(status.omState, null); assert.equal(status.errors.omState, "NotAllowedError");
  assert.equal(status.missingInput, false);
});
