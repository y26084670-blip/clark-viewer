import test from "node:test";
import assert from "node:assert/strict";
import { listTaskProtocolDownloads, readProtocolDownload, scanTaskProtocolDownloads } from "../src/services/protocol/protocolDownloads.js";
import { PROTOCOL_MAX_BYTES } from "../src/services/protocol/protocolDocument.js";

function filesystem(files = {}) {
  const calls = [], contents = new Map(Object.entries(files));
  const fileHandle = name => ({ kind: "file", name, async getFile() {
    calls.push({ operation: "metadata", name });
    const content = contents.get(name);
    if (!content) throw new DOMException("missing", "NotFoundError");
    return new File([content], name, { lastModified: 1234 });
  } });
  const docs = {
    async *entries() {
      for (const name of contents.keys()) yield [name, fileHandle(name)];
      yield ["folder.html", { kind: "directory" }];
    },
    async getFileHandle(name, options) { calls.push({ operation: "lookup", name, options }); return fileHandle(name); },
  };
  return { contents, calls, handle: { async getDirectoryHandle(name, options) {
    calls.push({ operation: "directory", name, options });
    assert.equal(name, "DOCS"); return docs;
  } } };
}

test("protocol indicator reads only direct HTML metadata, sorted like the editor, without writes or content reads", async () => {
  const fs = filesystem({ "p10.HTML": "ten", "p2.html": "two", "readme.txt": "note", "legacy.htm": "other" });
  const entries = await listTaskProtocolDownloads(fs.handle);
  assert.deepEqual(entries.map(entry => entry.name), ["p2.html", "p10.HTML"]);
  assert.deepEqual(entries.map(({ size, lastModified }) => ({ size, lastModified })), [
    { size: 3, lastModified: 1234 }, { size: 3, lastModified: 1234 },
  ]);
  assert.ok(fs.calls.every(call => !call.options || call.options.create === false));
  assert.deepEqual(fs.calls.filter(call => call.operation === "metadata").map(call => call.name), ["p2.html", "p10.HTML"]);
  const missing = { async getDirectoryHandle() { throw new DOMException("missing", "NotFoundError"); } };
  assert.deepEqual(await listTaskProtocolDownloads(missing), []);
});

test("download preserves exact original UTF-8/CRLF/media bytes and reads the latest saved file", async () => {
  const fs = filesystem({ "p.html": "old" });
  const [entry] = await listTaskProtocolDownloads(fs.handle);
  const bytes = new Uint8Array(Buffer.from('\ufeff<!doctype html>\r\n<p>Протокол</p><video src="data:video/webm;base64,AA=="></video>\r\n'));
  fs.contents.set("p.html", bytes);
  const download = await readProtocolDownload(entry);
  assert.equal(download.name, "p.html");
  assert.equal(download.blob.type, "text/html;charset=utf-8");
  assert.deepEqual(new Uint8Array(await download.blob.arrayBuffer()), bytes);
  assert.equal(fs.contents.get("p.html"), bytes);
});

test("deleted, empty, oversized and unsafe files cannot start a download", async () => {
  const fs = filesystem({ "p.html": "source" }), [entry] = await listTaskProtocolDownloads(fs.handle);
  fs.contents.delete("p.html");
  await assert.rejects(readProtocolDownload(entry), { name: "NotFoundError" });
  await assert.rejects(readProtocolDownload({ name: "../p.html", handle: { getFile() { assert.fail("path rejected before reading"); } } }), /имя файла/);
  await assert.rejects(readProtocolDownload({ name: "p.html", handle: { getFile: async () => new Blob() } }), /пуст/);
  await assert.rejects(readProtocolDownload({ name: "p.html", handle: { getFile: async () => ({ size: PROTOCOL_MAX_BYTES + 1 }) } }), /256 МиБ/);
});

test("metadata scans are bounded and a denied task never hides another task's protocols", async () => {
  let active = 0, peak = 0;
  const tasks = Array.from({ length: 14 }, (_, index) => ({ handle: {
    async getDirectoryHandle() {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      if (index === 4) throw new DOMException("access denied", "NotAllowedError");
      return { async *entries() {} };
    },
  } }));
  const fs = filesystem({ "ready.html": "saved" }); tasks.push({ handle: fs.handle });
  const records = await scanTaskProtocolDownloads(tasks, { concurrency: 3 });
  assert.equal(peak, 3); assert.equal(records.size, 15);
  assert.equal(records.get(tasks[4].handle).error, "access denied");
  assert.deepEqual(records.get(fs.handle).files.map(entry => entry.name), ["ready.html"]);
});

test("cancellation prevents late metadata publication and stale downloads", async () => {
  const controller = new AbortController();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const task = { handle: { async getDirectoryHandle() { started(); await gate; return { async *entries() {} }; } } };
  const pending = scanTaskProtocolDownloads([task], { signal: controller.signal });
  await ready; controller.abort(); release();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(readProtocolDownload({ name: "p.html", handle: { getFile() { assert.fail("aborted"); } } },
    { signal: controller.signal }), { name: "AbortError" });
});
