import test from "node:test";
import assert from "node:assert/strict";
import { listTaskTestProtocols, readTaskTestProtocol } from "../src/services/taskTestProtocolService.js";

const fsError = (name, message = name) => Object.assign(new Error(message), { name });

function filesystem() {
  const environment = { calls: [], hook: null };
  const hit = async (operation, handle, extra = {}) => {
    const call = { operation, handle, ...extra }; environment.calls.push(call);
    await environment.hook?.(call);
  };
  class FileHandle {
    constructor(name, blob) { this.name = name; this.kind = "file"; this.blob = blob; }
    async getFile() {
      await hit("getFile", this);
      return new File([this.blob], this.name, { type: this.blob.type });
    }
  }
  class DirectoryHandle {
    constructor(name) { this.name = name; this.kind = "directory"; this.children = new Map(); }
    async getDirectoryHandle(name, options = {}) {
      await hit("directory", this, { name, options });
      const child = this.children.get(name);
      if (!child) throw fsError("NotFoundError");
      if (child.kind !== "directory") throw fsError("TypeMismatchError");
      return child;
    }
    async *entries() {
      await hit("entries", this);
      for (const entry of this.children) {
        await hit("entry", this, { name: entry[0] });
        yield entry;
      }
      await hit("end", this);
    }
  }
  const root = new DirectoryHandle("task");
  const directory = path => path.split("/").filter(Boolean).reduce((parent, name) => {
    if (!parent.children.has(name)) parent.children.set(name, new DirectoryHandle(name));
    return parent.children.get(name);
  }, root);
  const file = (path, blob = new Blob(["<!doctype html><title>Test</title>"])) => {
    const parts = path.split("/"), name = parts.pop(), parent = directory(parts.join("/"));
    const handle = new FileHandle(name, blob); parent.children.set(name, handle); return handle;
  };
  return { root, directory, file, environment };
}

test("missing task comparison returns an empty list and ignores HTML in other directories without creating anything", async () => {
  const f = filesystem();
  assert.deepEqual(await listTaskTestProtocols(null), []);
  assert.deepEqual(await listTaskTestProtocols(f.root), []);
  f.file("output3XX/comparison/mufem/report.html");
  f.file("output3XX/comparasion/mufem/report.html");
  f.file("comparasion/mufem/report.html");
  f.file("input3XX/comparison/mufem/report.html");
  assert.deepEqual(await listTaskTestProtocols(f.root), []);
  assert.deepEqual(f.environment.calls.map(call => call.name), ["comparison", "comparison"]);
  assert.ok(f.environment.calls.every(call => call.operation === "directory" && call.options.create === false));
  assert.equal(f.root.children.has("comparison"), false);
});

test("task comparison discovery works without output3XX and preserves arbitrary names, duplicate paths, and Russian numeric sorting", async () => {
  const f = filesystem();
  const paths = ["mufem/report10.html", "mufem/report2.HTML", "comsol/вложено/Отчёт.html", "root.html", "comsol/report2.html", "mufem/Отчёт.html", "another-model run/report with spaces.html"];
  const handles = new Map(paths.map(path => [path, f.file(`comparison/${path}`)]));
  f.file("comparison/mufem/notes.txt");
  f.file("comparison/mufem/page.htm");
  f.directory("comparison/not-a-file.html");
  f.file("demo/ignored.html");
  assert.equal(f.root.children.has("output3XX"), false);
  const found = await listTaskTestProtocols(f.root);
  assert.deepEqual(found.map(entry => entry.path),
    ["another-model run/report with spaces.html", "comsol/вложено/Отчёт.html", "comsol/report2.html", "mufem/Отчёт.html", "mufem/report2.HTML", "mufem/report10.html", "root.html"]);
  for (const entry of found) {
    assert.equal(entry.name, entry.path.split("/").at(-1));
    assert.equal(entry.handle, handles.get(entry.path));
  }
  assert.equal(f.environment.calls.some(call => call.operation === "getFile"), false);
  assert.ok(f.environment.calls.filter(call => call.operation === "directory").every(call => call.options.create === false));
});

test("sort order is independent of discovery order even for names that collate alike", async () => {
  const paths = ["report02.html", "report2.html", "REPORT2.html", "Report2.html"];
  const discover = async order => {
    const f = filesystem();
    for (const path of order) f.file(`comparison/${path}`);
    return (await listTaskTestProtocols(f.root)).map(entry => entry.path);
  };
  assert.deepEqual(await discover(paths), await discover([...paths].reverse()));
});

test("invalid task handles and wrong directory types report errors instead of appearing empty", async () => {
  for (const handle of [{}, { kind: "file" }, { kind: "directory" }]) {
    await assert.rejects(listTaskTestProtocols(handle), /локальное задание/);
  }
  const f = filesystem(); f.file("comparison");
  await assert.rejects(listTaskTestProtocols(f.root), { name: "TypeMismatchError" });
});

test("denied access and enumeration errors propagate, while a disappearing subdirectory is skipped", async () => {
  for (const operation of ["directory", "entries", "entry", "end"]) {
    const f = filesystem(); f.file("comparison/mufem/report.html");
    const error = fsError("NotAllowedError", `${operation} denied`);
    f.environment.hook = call => { if (call.operation === operation) throw error; };
    await assert.rejects(listTaskTestProtocols(f.root), candidate => candidate === error);
  }
  const f = filesystem();
  f.file("comparison/disappeared/report.html");
  const kept = f.file("comparison/mufem/report.html");
  f.environment.hook = call => { if (call.operation === "entries" && call.handle.name === "disappeared") throw fsError("NotFoundError"); };
  assert.deepEqual(await listTaskTestProtocols(f.root), [{ name: "report.html", path: "mufem/report.html", handle: kept }]);
});

test("abort checks cover directory reads, entry iteration, and completion of an empty iterator", async () => {
  const already = new AbortController(); already.abort();
  await assert.rejects(listTaskTestProtocols(null, { signal: already.signal }), { name: "AbortError" });
  for (const operation of ["directory", "entries", "entry", "end"]) {
    const f = filesystem(), abort = new AbortController();
    if (operation === "entry") f.file("comparison/report.html");
    else f.directory("comparison");
    f.environment.hook = call => { if (call.operation === operation) abort.abort(); };
    await assert.rejects(listTaskTestProtocols(f.root, { signal: abort.signal }), { name: "AbortError" });
  }
});

test("an aborted failing discovery never resolves as a stale empty list", async () => {
  const f = filesystem(), abort = new AbortController();
  f.environment.hook = call => {
    if (call.operation === "directory") { abort.abort(); throw fsError("NotFoundError"); }
  };
  await assert.rejects(listTaskTestProtocols(f.root, { signal: abort.signal }), { name: "AbortError" });
});

test("read returns HTML MIME even for an untyped file and preserves all original bytes", async () => {
  const f = filesystem();
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x21, 0x44, 0x4f, 0x43, 0xd0, 0x00, 0xff]);
  for (const type of ["", "application/octet-stream", "text/plain"]) {
    const handle = f.file("comparison/report.HTML", new Blob([bytes], { type }));
    const result = await readTaskTestProtocol(handle);
    assert.ok(result instanceof Blob); assert.equal(result.type, "text/html");
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  }
  const empty = await readTaskTestProtocol(f.file("comparison/empty.html", new Blob()));
  assert.equal(empty.size, 0); assert.equal(empty.type, "text/html");
});

test("read validates HTML file handles before touching their contents", async () => {
  const f = filesystem();
  const invalid = [null, f.directory("comparison/folder.html"), f.file("comparison/report.htm"),
    { kind: "file", name: "report.html" }, { kind: "file", name: "../report.html", getFile() { throw new Error("must not read"); } }];
  for (const handle of invalid) await assert.rejects(readTaskTestProtocol(handle), /HTML-файл/);
  assert.equal(f.environment.calls.length, 0);
});

test("file read errors propagate and cancelled reads cannot publish stale documents", async () => {
  for (const name of ["NotFoundError", "NotAllowedError"]) {
    const f = filesystem(), handle = f.file("comparison/report.html"), error = fsError(name);
    f.environment.hook = call => { if (call.operation === "getFile") throw error; };
    await assert.rejects(readTaskTestProtocol(handle), candidate => candidate === error);
  }
  for (const fail of [false, true]) {
    const f = filesystem(), handle = f.file("comparison/report.html"), abort = new AbortController();
    f.environment.hook = call => {
      if (call.operation === "getFile") { abort.abort(); if (fail) throw fsError("NotAllowedError"); }
    };
    await assert.rejects(readTaskTestProtocol(handle, { signal: abort.signal }), { name: "AbortError" });
  }
});
