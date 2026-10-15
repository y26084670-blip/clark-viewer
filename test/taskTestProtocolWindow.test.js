import test from "node:test";
import assert from "node:assert/strict";
import { createTaskTestProtocolWindow } from "../src/services/taskTestProtocolWindow.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Only the window/document APIs used by the opener; no global browser state.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "id") this.id = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get lastChild() { return this.children.at(-1); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, event) { this.listeners.get(name)?.(event); }
  focus() { this.focused = true; }
}

function runtime(options = {}) {
  const windows = [], urls = [], revoked = [], calls = [];
  const opener = createTaskTestProtocolWindow({
    openWindow() {
      calls.push("open");
      if (options.blocked) return null;
      const tab = new Node("window");
      tab.document = { head: new Node("head"), body: new Node("body"), createElement: tag => new Node(tag) };
      tab.removeEventListener = name => tab.listeners.delete(name);
      tab.close = () => { tab.closed = true; tab.emit("pagehide"); };
      windows.push(tab); return tab;
    },
    async list(handle, { signal }) { calls.push("list"); return options.list?.(handle, signal) ?? []; },
    async read(handle, { signal }) { calls.push(`read:${handle.name}`); return options.read?.(handle, signal) ?? new Blob([handle.name], { type: "text/html" }); },
    createUrl(blob) { const url = `blob:report-${urls.length}`; urls.push({ url, blob }); return url; },
    revokeUrl(url) { revoked.push(url); },
  });
  return { opener, windows, urls, revoked, calls };
}

const entry = path => ({ path, name: path.split("/").at(-1), handle: { kind: "file", name: path.split("/").at(-1) } });
const task = { name: "Задание", kind: "directory" };
const descendants = node => [node, ...node.children.flatMap(descendants)];
const nodes = (tab, tag) => descendants(tab.document.body).filter(node => node.tag === tag);

test("one window is reserved synchronously and all HTML documents open with distinct full-path tabs", async () => {
  const scan = deferred(), entries = [entry("report.html"), entry("mufem_1000AT/details/all_states/report.HTML"), entry("другая модель/<Отчёт>.html")];
  const h = runtime({ list: (handle, signal) => {
    assert.equal(handle, task); assert.equal(signal.aborted, false); return scan.promise;
  } });
  const opening = h.opener.open(task, { label: "Проект/Задание" });
  assert.deepEqual(h.calls, ["open", "list"]);
  assert.equal(h.windows[0].opener, null);
  scan.resolve(entries);
  assert.deepEqual(await opening, { opened: 3, failures: [] });
  const tab = h.windows[0], buttons = nodes(tab, "button"), frames = nodes(tab, "iframe");
  assert.equal(h.windows.length, 1);
  assert.equal(tab.document.title, "Протоколы тестов — Проект/Задание");
  assert.deepEqual(buttons.map(button => button.textContent), entries.map(item => `comparison/${item.path}`));
  assert.deepEqual(frames.map(frame => frame.attributes.src), h.urls.map(item => item.url));
  assert.equal(h.urls.length, 3); assert.deepEqual(h.revoked, []);
  for (let i = 0; i < entries.length; i++) assert.equal(await h.urls[i].blob.text(), entries[i].name);
  const panels = nodes(tab, "section");
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true]);
  buttons[2].emit("click");
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, false]);
  assert.deepEqual(buttons.map(button => button.attributes["aria-selected"]), ["false", "false", "true"]);
  assert.equal(nodes(tab, "a")[0].href, h.urls[2].url);
  let prevented = false;
  buttons[2].emit("keydown", { key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(buttons[0].focused, true);
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true]);
  h.opener.dispose();
});

test("a missing or unreadable HTML does not prevent the remaining protocols from opening", async () => {
  const entries = [entry("a/report.html"), entry("b/report.html"), entry("c/report.html")];
  const h = runtime({ list: () => entries, read: handle => {
    if (handle === entries[1].handle) throw new Error("Файл удалён");
    return new Blob([handle.name]);
  } });
  const result = await h.opener.open(task);
  assert.equal(result.opened, 2); assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /comparison\/b\/report.html: Файл удалён/);
  assert.equal(nodes(h.windows[0], "iframe").length, 2);
  assert.equal(nodes(h.windows[0], "p").find(node => node.attributes.role === "alert").textContent, result.failures[0]);
  h.opener.dispose();
});

test("empty directories, denied scans, and failure of every file close the pending window and report the reason", async () => {
  for (const options of [
    {},
    { list() { throw new Error("Нет доступа к comparison"); } },
    { list: () => [entry("report.html")], read() { throw new Error("Нет доступа к HTML"); } },
  ]) {
    const h = runtime(options);
    await assert.rejects(h.opener.open(task), /HTML-протоколов|Нет доступа/);
    assert.equal(h.windows[0].closed, true); assert.deepEqual(h.revoked, []);
  }
});

test("blocked windows do not read the filesystem and explain how to retry", async () => {
  const h = runtime({ blocked: true });
  await assert.rejects(h.opener.open(task), /Браузер заблокировал.*щелчок по T/);
  assert.deepEqual(h.calls, ["open"]);
});

test("closing a pending window cancels discovery and cannot publish stale documents", async () => {
  const scan = deferred(); let signal;
  const h = runtime({ list: (_handle, value) => { signal = value; return scan.promise; } });
  const opening = h.opener.open(task);
  h.windows[0].close(); assert.equal(signal.aborted, true);
  scan.resolve([entry("report.html")]);
  await assert.rejects(opening, { name: "AbortError" });
  assert.deepEqual(h.calls, ["open", "list"]); assert.deepEqual(h.urls, []);
});

test("closing one report collection releases only its URLs; another collection stays usable", async () => {
  const h = runtime({ list: () => [entry("nested/report.html")] });
  await h.opener.open(task); await h.opener.open(task);
  h.windows[0].close();
  assert.deepEqual(h.revoked, [h.urls[0].url]);
  assert.notEqual(h.windows[1].closed, true);
  h.opener.dispose();
  assert.deepEqual(h.revoked, h.urls.map(item => item.url));
});

test("dispose interrupts a pending read, closes its window and releases previously read documents", async () => {
  const read = deferred(), started = deferred(), entries = [entry("a.html"), entry("b.html")];
  let signal;
  const h = runtime({ list: () => entries, read(handle, current) {
    if (handle === entries[1].handle) { signal = current; started.resolve(); return read.promise; }
    return new Blob(["first"]);
  } });
  const opening = h.opener.open(task); await started.promise;
  assert.equal(h.urls.length, 1);
  h.opener.dispose(); assert.equal(signal.aborted, true); assert.equal(h.windows[0].closed, true);
  assert.deepEqual(h.revoked, [h.urls[0].url]);
  read.resolve(new Blob(["late"]));
  await assert.rejects(opening, { name: "AbortError" });
  assert.equal(h.urls.length, 1);
  await assert.rejects(h.opener.open(task), { name: "AbortError" });
  assert.equal(h.windows.length, 1);
});
