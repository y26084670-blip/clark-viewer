import assert from "node:assert/strict";
import test from "node:test";
import { listTaskDocs, preferredTaskDoc, readTaskDocsImage, readTaskDocsText, readTaskDocsDocument,
  TASK_DOCS_IMAGE_MAX_BYTES, TASK_DOCS_TEXT_MAX_BYTES, TASK_DOCS_HTML_MAX_BYTES } from "../src/services/taskDocsService.js";
import { createTaskDocsTextController } from "../src/services/taskDocsTextController.js";
import { createTaskImageGalleryController } from "../src/services/taskImageGalleryController.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const handle = (name, body = name) => ({ kind: "file", name, getFile: async () => body instanceof Blob ? body : new Blob([body]) });
const entry = name => ({ name, handle: handle(name) });

test("DOCS lists immediate supported files, sorts naturally and never reads bytes or asks write permission", async () => {
  const entries = ["10_end.PNG", "2_view.WebP", "01_sketch.JPEG", "README.txt", "README.md", "notes.TXT", "report10.HTML", "report2.htm", "extra.json", "movie.gif", "bad/escape.png"]
    .map(name => [name, { kind: "file", name, getFile() { assert.fail("metadata scan read a file"); } }]);
  entries.push(["nested.png", { kind: "directory" }]);
  const task = { kind: "directory", async getDirectoryHandle(name, options) {
    assert.equal(name, "DOCS"); assert.deepEqual(options, { create: false });
    return { async *entries() { yield* entries; } };
  }, requestPermission() { assert.fail("read-only scan requested permission"); } };
  const result = await listTaskDocs(task);
  assert.deepEqual(result.images.map(item => item.name), ["01_sketch.JPEG", "2_view.WebP", "10_end.PNG"]);
  assert.deepEqual(result.documents.map(item => item.name), ["notes.TXT", "README.md", "README.txt", "report2.htm", "report10.HTML"]);
  assert.equal(preferredTaskDoc(result.documents).name, "README.txt");
  assert.equal(preferredTaskDoc(result.documents, "notes.TXT").name, "notes.TXT");
  assert.equal(preferredTaskDoc([entry("a.txt"), entry("readme.MD")]).name, "readme.MD");
  assert.equal(preferredTaskDoc([entry("a.txt")]).name, "a.txt");
  assert.equal(preferredTaskDoc([]), null);
});

test("HTML documents support embedded images beyond the plain-text limit and retain the original source", async () => {
  const html = '<!doctype html><title>Протокол</title><p>' + 'x'.repeat(TASK_DOCS_TEXT_MAX_BYTES) + '</p>';
  assert.equal(await readTaskDocsDocument(handle("protocol.HTML", html)), html);
  assert.equal(await readTaskDocsDocument(handle("report.htm", "<b>Отчёт</b>")), "<b>Отчёт</b>");
  assert.equal(await readTaskDocsDocument(handle("README.md", "# Текст")), "# Текст");
  await assert.rejects(readTaskDocsDocument(handle("README.txt", html)), /2 МиБ/);
  const huge = new Blob([]); Object.defineProperty(huge, "size", { value: TASK_DOCS_HTML_MAX_BYTES + 1 });
  await assert.rejects(readTaskDocsDocument(handle("huge.html", huge)), /64 МиБ/);
  await assert.rejects(readTaskDocsDocument(handle("bad.html", new Blob([new Uint8Array([0xff, 0xfe])]))), /UTF-8/);
  await assert.rejects(readTaskDocsDocument(handle("data.json")), /Выберите/);
});

test("an HTML read cancelled during native file access does not publish stale content", async () => {
  const pending = deferred(), abort = new AbortController();
  const operation = readTaskDocsDocument({ ...handle("late.html"), getFile: () => pending.promise }, { signal: abort.signal });
  abort.abort(); pending.resolve(new Blob(["<p>old task</p>"]));
  await assert.rejects(operation, { name: "AbortError" });
});

test("missing DOCS is empty; permission errors and cancellation are not disguised as an empty directory", async () => {
  const task = name => ({ kind: "directory", getDirectoryHandle: async () => { throw Object.assign(new Error(name), { name }); } });
  assert.deepEqual(await listTaskDocs(null), { images: [], documents: [] });
  assert.deepEqual(await listTaskDocs(task("NotFoundError")), { images: [], documents: [] });
  await assert.rejects(listTaskDocs(task("NotAllowedError")), /NotAllowed/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(listTaskDocs(task("NotFoundError"), { signal: abort.signal }), { name: "AbortError" });
  const pending = deferred(), later = new AbortController();
  const read = listTaskDocs({ kind: "directory", getDirectoryHandle: () => pending.promise }, { signal: later.signal });
  later.abort(); pending.reject(Object.assign(new Error(), { name: "NotFoundError" }));
  await assert.rejects(read, { name: "AbortError" });
});

test("PNG, JPEG and WebP require matching signatures and are returned with their native MIME types", async () => {
  for (const [name, bytes, type] of [
    ["image.PNG", [137, 80, 78, 71, 13, 10, 26, 10], "image/png"],
    ["image.jpg", [255, 216, 255, 224], "image/jpeg"],
    ["image.JPEG", [255, 216, 255, 224], "image/jpeg"],
    ["image.webp", new TextEncoder().encode("RIFF0000WEBP"), "image/webp"],
  ]) {
    const blob = await readTaskDocsImage(handle(name, new Blob([new Uint8Array(bytes)], { type: "text/html" })));
    assert.equal(blob.type, type);
  }
  await assert.rejects(readTaskDocsImage(handle("image.png", "<html>")), /не соответствует/);
  await assert.rejects(readTaskDocsImage(handle("../image.png")), /Выберите/);
  await assert.rejects(readTaskDocsImage(handle("image.svg")), /Выберите/);
  const huge = new Blob([]); Object.defineProperty(huge, "size", { value: TASK_DOCS_IMAGE_MAX_BYTES + 1 });
  await assert.rejects(readTaskDocsImage(handle("image.png", huge)), /64 МиБ/);
});

test("TXT/MD preserve literal markup, accept UTF-8 BOM and empty text, and reject other encodings and oversized files", async () => {
  const markdown = "# Эскиз\n<script>alert(1)</script>\n[файл](../data.json)";
  assert.equal(await readTaskDocsText(handle("README.md", `\ufeff${markdown}`)), markdown);
  assert.equal(await readTaskDocsText(handle("empty.txt", "")), "");
  await assert.rejects(readTaskDocsText(handle("legacy.txt", new Blob([new Uint8Array([0xff, 0xfe, 0x61])]))), /UTF-8/);
  const huge = new Blob([]); Object.defineProperty(huge, "size", { value: TASK_DOCS_TEXT_MAX_BYTES + 1 });
  await assert.rejects(readTaskDocsText(handle("huge.txt", huge)), /2 МиБ/);
  await assert.rejects(readTaskDocsText(handle("file.json")), /Выберите/);
  const pending = deferred(), abort = new AbortController();
  const operation = readTaskDocsText({ ...handle("late.txt"), getFile: () => pending.promise }, { signal: abort.signal });
  abort.abort(); pending.resolve(new Blob(["late"])); await assert.rejects(operation, { name: "AbortError" });
});

function textFixture(options = {}) {
  let state; const states = [];
  const controller = createTaskDocsTextController({
    list: async () => ({ images: [], documents: [entry("notes.txt"), entry("README.md"), entry("README.txt")] }),
    read: async item => item.name, ...options,
    publish: next => { state = next; states.push(next); },
  });
  return { controller, states, get state() { return state; } };
}

test("text reads only the selected visible document and preserves selection through refresh and local tabs", async () => {
  const reads = []; let lists = 0;
  const ui = textFixture({ list: async () => { lists++; return { documents: [entry("README.txt"), entry("notes.txt")] }; },
    read: async file => { reads.push(file.name); return file.name; } });
  ui.controller.setDisplayActive(false); ui.controller.setContext({}); await tick();
  assert.equal(lists, 0); assert.deepEqual(reads, []);
  ui.controller.setDisplayActive(true); await tick(); assert.equal(ui.state.text, "README.txt");
  assert.deepEqual(reads, ["README.txt"]);
  ui.controller.select("notes.txt"); await tick(); ui.controller.refresh(); await tick();
  assert.equal(ui.state.selected.name, "notes.txt");
  ui.controller.setDisplayActive(false); ui.controller.refresh(); await tick(); const before = reads.length;
  ui.controller.setDisplayActive(true); await tick(); assert.equal(reads.length, before + 1);
  assert.equal(ui.state.selected.name, "notes.txt"); ui.controller.dispose();
});

test("late text reads cannot overwrite a new selection or task and cancelled reads keep their slot", async () => {
  const jobs = [];
  const ui = textFixture({ read: (file, { signal }) => { const job = deferred(); jobs.push({ ...job, file, signal }); return job.promise; } });
  ui.controller.setContext({ name: "old" }); await tick(); assert.equal(jobs.length, 1);
  ui.controller.select("notes.txt"); assert.equal(jobs[0].signal.aborted, true);
  ui.controller.select("README.md"); await tick(); assert.equal(jobs.length, 1);
  jobs[0].resolve("stale selection"); await tick(); assert.equal(jobs.length, 2);
  assert.equal(jobs[1].file.name, "README.md");
  ui.controller.setContext({ name: "new" }); await tick();
  jobs[1].reject(new Error("stale task")); await tick();
  jobs[2].resolve("current"); await tick();
  assert.equal(ui.state.text, "current"); assert.equal(ui.state.error, "");
  assert.ok(ui.states.every(state => state.text !== "stale selection" && state.error !== "stale task"));
  ui.controller.dispose();
});

test("text scans coalesce, removed selections fall back, access errors clear stale content", async () => {
  const jobs = [];
  const ui = textFixture({ list: (_task, { signal }) => { const job = deferred(); jobs.push({ ...job, signal }); return job.promise; } });
  ui.controller.setContext({}); await tick(); ui.controller.refresh(); ui.controller.refresh();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].signal.aborted, true);
  jobs[0].resolve({ documents: [entry("old.txt")] }); await tick(); assert.equal(jobs.length, 2);
  jobs[1].resolve({ documents: [entry("README.md"), entry("notes.txt")] }); await tick();
  ui.controller.select("notes.txt"); await tick(); assert.equal(ui.state.text, "notes.txt");
  ui.controller.refresh(); await tick(); jobs[2].resolve({ documents: [entry("README.md")] }); await tick();
  assert.equal(ui.state.text, "README.md");
  ui.controller.refresh(); await tick(); jobs[3].reject(new Error("Access denied")); await tick();
  assert.equal(ui.state.text, ""); assert.equal(ui.state.selected, null); assert.equal(ui.state.error, "Access denied");
  ui.controller.dispose();
});

test("hidden or disposed text controllers discard pending results; empty folders end loading", async () => {
  const job = deferred();
  const ui = textFixture({ read: () => job.promise }); ui.controller.setContext({}); await tick();
  ui.controller.setDisplayActive(false); job.resolve("hidden"); await tick(); assert.equal(ui.state.text, "");
  ui.controller.dispose();
  const empty = textFixture({ list: async () => ({ documents: [] }) }); empty.controller.setContext({}); await tick();
  assert.equal(empty.state.loading, false); assert.equal(empty.state.selected, null); empty.controller.dispose();
});

test("documentation image controller has no deletion capability", async () => {
  let state;
  const controller = createTaskImageGalleryController({ publish: next => { state = next; }, list: async () => [entry("image.png")], read: async () => new Blob([]) });
  controller.setContext({}); await tick(); assert.equal(await controller.deleteEntry(state.entries[0]), false); controller.dispose();
});
