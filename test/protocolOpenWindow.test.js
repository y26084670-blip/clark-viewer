import test from "node:test";
import assert from "node:assert/strict";
import { openProtocolWindow } from "../src/services/protocol/protocolOpenWindow.js";
import { readProtocolDownload } from "../src/services/protocol/protocolDownloads.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  close() { this.closed = true; this.listeners.get("pagehide")?.(); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const nodes = (tab, tag) => descendants(tab.document.body).filter(n => n.tag === tag);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = new File(['\uFEFF<!doctype html>\r\n<h1>Отчёт</h1><script>window.ready=true</script>'], "report.html");
const entry = { name: source.name, handle: { getFile: async () => source } };
function runtime(read = readProtocolDownload) {
  const tab = new Node("window"), calls = [], blobs = [], revoked = [];
  tab.Blob = Blob;
  tab.document = { head: new Node("head"), body: new Node("body"), createElement: tag => new Node(tag) };
  tab.URL = { createObjectURL(blob) { blobs.push(blob); return "blob:report"; }, revokeObjectURL(url) { revoked.push(url); } };
  const open = (signal, item = entry) => openProtocolWindow(item, {
    signal, openWindow() { calls.push("open"); return tab; },
    read(...args) { calls.push("read"); return read(...args); },
  });
  return { tab, calls, blobs, revoked, open };
}

test("reserves a tab before reading, severs opener, embeds and downloads identical original bytes", async () => {
  const h = runtime(), opening = h.open();
  assert.deepEqual(h.calls, ["open", "read"]);
  assert.equal(h.tab.opener, null);
  assert.equal(await opening, h.tab);
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array(await source.arrayBuffer()));
  assert.equal(nodes(h.tab, "iframe")[0].attributes.src, "blob:report");
  const link = nodes(h.tab, "a")[0];
  assert.equal(link.textContent, "Загрузить");
  assert.equal(link.attributes.download, "report.html");
  assert.equal(link.attributes.href, "blob:report");
  assert.deepEqual(h.revoked, []);
  h.tab.close(); assert.deepEqual(h.revoked, ["blob:report"]);
});

test("an opened report survives later selection cancellation until its own tab closes", async () => {
  const h = runtime(), request = new AbortController();
  await h.open(request.signal); request.abort();
  assert.equal(h.tab.closed, undefined); assert.deepEqual(h.revoked, []);
  h.tab.close(); assert.deepEqual(h.revoked, ["blob:report"]);
});

test("cancelling a pending read closes the placeholder immediately and never publishes a late report", async () => {
  const wait = deferred(), h = runtime(() => wait.promise), request = new AbortController();
  const opening = h.open(request.signal); request.abort();
  assert.equal(h.tab.closed, true);
  wait.resolve({ name: entry.name, blob: source });
  await assert.rejects(opening, { name: "AbortError" }); assert.deepEqual(h.blobs, []);
});

test("closing a pending tab aborts reading and prevents creation of an orphaned URL", async () => {
  const wait = deferred(); let readSignal;
  const h = runtime((entry, { signal }) => { readSignal = signal; return wait.promise; });
  const opening = h.open(); h.tab.close();
  assert.equal(readSignal.aborted, true);
  wait.resolve({ name: entry.name, blob: source });
  await assert.rejects(opening, { name: "AbortError" }); assert.deepEqual(h.blobs, []);
});

test("blocked popup and cancelled requests never read a file", async () => {
  let reads = 0;
  await assert.rejects(openProtocolWindow(entry, { openWindow: () => null, read() { reads++; } }), /заблокировал/);
  const h = runtime();
  await assert.rejects(h.open(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(reads, 0); assert.deepEqual(h.calls, []);
});

test("read failures close the placeholder and report the original error", async () => {
  const h = runtime(async () => { throw new Error("file removed"); });
  await assert.rejects(h.open(), /file removed/);
  assert.equal(h.tab.closed, true); assert.deepEqual(h.blobs, []);
});
