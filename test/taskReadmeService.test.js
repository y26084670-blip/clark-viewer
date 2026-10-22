import assert from "node:assert/strict";
import test from "node:test";
import { loadTaskReadme, saveTaskReadme, deleteTaskReadme } from "../src/services/taskReadmeService.js";

function fixture({ permission = "granted", failWrite = false } = {}) {
  const events = [], files = new Map();
  let hasDocs = false, time = 1;
  const put = (name, text) => { hasDocs = true; files.set(name, new File([text], name, { lastModified: time++ })); };
  const notFound = () => new DOMException("Missing", "NotFoundError");
  const handle = name => ({ kind: "file", name, async getFile() { if (!files.has(name)) throw notFound(); return files.get(name); },
    async createWritable(options) {
      events.push(["writable", options]); let text;
      return { async write(value) { if (failWrite) throw new Error("disk full"); text = value; },
        async close() { put(name, text); events.push(["close"]); }, async abort() { events.push(["abort"]); } };
    } });
  const docs = { kind: "directory", name: "DOCS",
    async *entries() { for (const name of files.keys()) yield [name, handle(name)]; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) { if (!create) throw notFound(); put(name, ""); }
      return handle(name);
    },
    async removeEntry(name) { assert.ok(files.has(name)); files.delete(name); events.push(["remove", name]); },
  };
  const task = { kind: "directory", name: "task",
    async requestPermission(options) { events.push(["permission", options]); return permission; },
    async getDirectoryHandle(name, { create = false } = {}) {
      assert.equal(name, "DOCS");
      if (!hasDocs) { if (!create) throw notFound(); hasDocs = true; events.push(["mkdir"]); }
      return docs;
    },
  };
  return { task, put, files, events, hasDocs: () => hasDocs };
}

test("reading missing README has no writes; creating UTF-8 creates DOCS only on save", async () => {
  const f = fixture(), before = await loadTaskReadme(f.task);
  assert.equal(before.exists, false); assert.equal(f.hasDocs(), false); assert.deepEqual(f.events, []);
  await saveTaskReadme(f.task, before, "Условие задачи\nток 1 А");
  assert.equal((await loadTaskReadme(f.task)).text, "Условие задачи\nток 1 А");
  assert.equal(f.events[0][0], "permission");
});

test("edit replaces a longer existing file, preserves case and unrelated documents; delete removes only README", async () => {
  const f = fixture(); f.put("Readme.TXT", "long original text"); f.put("notes.md", "keep");
  await saveTaskReadme(f.task, await loadTaskReadme(f.task), "short");
  assert.equal(await f.files.get("Readme.TXT").text(), "short"); assert.equal(f.files.has("README.txt"), false);
  assert.deepEqual(f.events.find(entry => entry[0] === "writable")[1], { keepExistingData: false });
  await deleteTaskReadme(f.task, await loadTaskReadme(f.task));
  assert.deepEqual([...f.files.keys()], ["notes.md"]); assert.equal(f.hasDocs(), true);
});

test("stale save, stale delete and concurrent create leave external contents intact", async () => {
  const f = fixture(), absent = await loadTaskReadme(f.task); f.put("README.txt", "external");
  await assert.rejects(saveTaskReadme(f.task, absent, "mine"), /изменён после открытия/);
  const before = await loadTaskReadme(f.task); f.put("README.txt", "updated");
  await assert.rejects(saveTaskReadme(f.task, before, "mine"), /изменён после открытия/);
  await assert.rejects(deleteTaskReadme(f.task, before), /изменён после открытия/);
  assert.equal(await f.files.get("README.txt").text(), "updated");
  assert.equal(f.events.some(event => ["writable", "remove"].includes(event[0])), false);
});

test("permission refusal does not create folders or write/delete files", async () => {
  const f = fixture({ permission: "denied" });
  await assert.rejects(saveTaskReadme(f.task, await loadTaskReadme(f.task), "text"), /Нет разрешения/);
  assert.equal(f.hasDocs(), false);
  f.put("README.txt", "keep");
  await assert.rejects(deleteTaskReadme(f.task, await loadTaskReadme(f.task)), /Нет разрешения/);
  assert.equal(await f.files.get("README.txt").text(), "keep");
});

test("failed writes abort, keep the previous file and propagate the error", async () => {
  const f = fixture({ failWrite: true }); f.put("README.txt", "keep");
  await assert.rejects(saveTaskReadme(f.task, await loadTaskReadme(f.task), "new"), /disk full/);
  assert.equal(await f.files.get("README.txt").text(), "keep");
  assert.ok(f.events.some(event => event[0] === "abort"));
});

test("empty README is supported, size limit counts UTF-8 bytes, duplicate names are rejected", async () => {
  const f = fixture();
  await saveTaskReadme(f.task, await loadTaskReadme(f.task), "");
  assert.equal((await loadTaskReadme(f.task)).text, "");
  await assert.rejects(saveTaskReadme(f.task, await loadTaskReadme(f.task), "Я".repeat(1048577)), /2 МиБ/);
  f.put("readme.txt", "ambiguous");
  await assert.rejects(loadTaskReadme(f.task), /неоднозначное/);
});
