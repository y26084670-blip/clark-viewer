import test from "node:test";
import assert from "node:assert/strict";
import { TASK_GIF_MAX_BYTES, listTaskGifs, readTaskGif, saveTaskGif, deleteTaskGif, subscribeTaskGifs } from "../src/services/taskGifService.js";

const gif = (signature = "GIF89a") => new Blob([signature, new Uint8Array([1, 0, 1, 0, 0, 0, 0, 59])], { type: "image/gif" });
const fsError = (name, message = name) => Object.assign(new Error(message), { name });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function filesystem() {
  const environment = { calls: [], permission: "granted", hook: null, streams: [], modified: 1 };
  const hit = async (operation, handle, extra = {}) => {
    const call = { operation, handle, ...extra }; environment.calls.push(call);
    await environment.hook?.(call);
  };
  class Handle {
    constructor(name, kind) { this.name = name; this.kind = kind; }
    async isSameEntry(other) {
      await hit("same", this, { other });
      // FSA identity is a locator, not an inode or file version.
      return this === other || (this.parent === other?.parent && this.name === other?.name);
    }
  }
  class FileHandle extends Handle {
    constructor(name, blob = new Blob()) { super(name, "file"); this.blob = blob; this.lastModified = environment.modified++; }
    async getFile() { await hit("getFile", this); return new File([this.blob], this.name, { type: this.blob.type, lastModified: this.lastModified }); }
    async createWritable(options) {
      await hit("createWritable", this, { options });
      const file = this;
      const stream = { aborted: false, closed: false, data: null,
        async write(data) { await hit("write", file, { data }); if (this.aborted) throw fsError("AbortError"); this.data = data; },
        async close() { await hit("close", file); if (this.aborted) throw fsError("AbortError"); file.blob = this.data; file.lastModified = environment.modified++; this.closed = true; await hit("committed", file); },
        async abort() { this.aborted = true; await hit("abort", file); },
      };
      environment.streams.push(stream); return stream;
    }
  }
  class DirectoryHandle extends Handle {
    constructor(name) { super(name, "directory"); this.children = new Map(); }
    requestPermission(options) {
      environment.calls.push({ operation: "permission", handle: this, options });
      return environment.permission;
    }
    async getDirectoryHandle(name, options = {}) {
      await hit("directory", this, { name, options });
      let child = this.children.get(name);
      if (child && child.kind !== "directory") throw fsError("TypeMismatchError");
      if (!child && options.create) { child = new DirectoryHandle(name); child.parent = this; this.children.set(name, child); }
      if (!child) throw fsError("NotFoundError");
      return child;
    }
    async getFileHandle(name, options = {}) {
      await hit("file", this, { name, options });
      let child = this.children.get(name);
      if (child && child.kind !== "file") throw fsError("TypeMismatchError");
      if (!child && options.create) { child = new FileHandle(name); child.parent = this; this.children.set(name, child); }
      if (!child) throw fsError("NotFoundError");
      return child;
    }
    async *entries() { await hit("entries", this); for (const entry of this.children) yield entry; }
    async removeEntry(name, options) { await hit("remove", this, { name, options }); if (!this.children.delete(name)) throw fsError("NotFoundError"); }
  }
  const root = new DirectoryHandle("task");
  const directory = path => path.split("/").filter(Boolean).reduce((parent, name) => {
    if (!parent.children.has(name)) { const child = new DirectoryHandle(name); child.parent = parent; parent.children.set(name, child); }
    return parent.children.get(name);
  }, root);
  const file = (path, blob = gif()) => {
    const parts = path.split("/"), name = parts.pop(), parent = directory(parts.join("/"));
    const handle = new FileHandle(name, blob); handle.parent = parent; parent.children.set(name, handle); return handle;
  };
  return { ...environment, environment, root, directory, file, FileHandle };
}

test("missing GIF directories list as empty without creation or requesting write permission", async () => {
  const f = filesystem();
  assert.deepEqual(await listTaskGifs(null), []);
  assert.deepEqual(await listTaskGifs(f.root), []);
  f.directory("output3XX");
  assert.deepEqual(await listTaskGifs(f.root), []);
  assert.ok(f.environment.calls.every(call => call.operation !== "permission" && call.options?.create !== true));
  assert.equal(f.root.children.get("output3XX").children.size, 0);
});

test("list accepts file GIF extensions case-insensitively and sorts names without reading file content", async () => {
  const f = filesystem();
  f.file("output3XX/demo/zebra.GIF"); f.file("output3XX/demo/Alpha.gif"); f.file("output3XX/demo/beta.gIf");
  f.file("output3XX/demo/readme.txt"); f.directory("output3XX/demo/folder.gif"); f.file("input3XX/ignored.gif");
  assert.deepEqual((await listTaskGifs(f.root)).map(entry => entry.name), ["Alpha.gif", "beta.gIf", "zebra.GIF"]);
  assert.equal(f.environment.calls.filter(call => ["getFile", "permission"].includes(call.operation)).length, 0);
});

test("reading validates GIF87a/GIF89a, rejects disguised HTML and checks the byte bound first", async () => {
  const f = filesystem();
  for (const signature of ["GIF87a", "GIF89a"]) {
    const handle = f.file(`output3XX/demo/${signature}.GIF`, gif(signature));
    const result = await readTaskGif(handle);
    assert.ok(result instanceof Blob); assert.equal(await result.slice(0, 6).text(), signature);
  }
  await assert.rejects(readTaskGif(f.file("output3XX/demo/fake.gif", new Blob(["<html>not GIF</html>"], { type: "image/gif" }))), /GIF87a/);
  await assert.rejects(readTaskGif(f.file("output3XX/demo/text.txt")), /GIF-файл/);
  const large = gif(); Object.defineProperty(large, "size", { value: TASK_GIF_MAX_BYTES + 1 });
  let sliced = false; large.slice = () => { sliced = true; throw new Error("must not read"); };
  const handle = { kind: "file", name: "large.gif", getFile: async () => large };
  await assert.rejects(readTaskGif(handle), /128 МиБ/); assert.equal(sliced, false);
});

test("save asks permission synchronously, creates only the target directories and commits before notification", async () => {
  const f = filesystem(), events = [];
  const unsubscribe = subscribeTaskGifs(() => events.push(f.environment.streams.at(-1)?.closed));
  try {
    const pending = saveTaskGif(f.root, gif(), "areas_2026-10-03_23-21-04.gif");
    assert.equal(f.environment.calls[0].operation, "permission");
    assert.deepEqual(f.environment.calls[0].options, { mode: "readwrite" });
    const saved = await pending;
    assert.equal(saved.name, "areas_2026-10-03_23-21-04.gif");
    assert.equal(await (await readTaskGif(saved.handle)).slice(0, 6).text(), "GIF89a");
    assert.deepEqual(events, [true]);
    assert.deepEqual([...f.root.children.keys()], ["output3XX"]);
    assert.deepEqual([...f.root.children.get("output3XX").children.keys()], ["demo"]);
    assert.ok(f.environment.calls.find(call => call.operation === "write").data instanceof Blob);
  } finally { unsubscribe(); }
});

test("save preserves existing files and directories and chooses numeric suffixes without regard to case", async () => {
  const f = filesystem();
  const first = f.file("output3XX/demo/MOVIE.GIF", gif("GIF87a"));
  f.directory("output3XX/demo/movie_2.gif");
  const saved = await saveTaskGif(f.root, gif(), "movie.gif");
  assert.equal(saved.name, "movie_3.gif");
  assert.equal(await first.blob.slice(0, 6).text(), "GIF87a");
  assert.ok(f.directory("output3XX/demo").children.get("movie_2.gif").kind === "directory");
  const parallel = await Promise.all([saveTaskGif(f.root, gif(), "same.gif"), saveTaskGif(f.root, gif(), "same.gif")]);
  assert.deepEqual(parallel.map(entry => entry.name), ["same.gif", "same_2.gif"]);
});

test("save normalizes Windows leaf names and does not follow paths supplied as a name", async () => {
  const f = filesystem();
  const reserved = await saveTaskGif(f.root, gif(), "CON.gif"); assert.equal(reserved.name, "_CON.gif");
  const path = await saveTaskGif(f.root, gif(), "../../bad\\name:?.gif");
  assert.match(path.name, /\.gif$/); assert.doesNotMatch(path.name, /[<>:"/\\|?*]/);
  assert.equal(f.directory("output3XX/demo").children.get(path.name), path.handle);
  const long = await saveTaskGif(f.root, gif(), "я".repeat(300) + ".gif"); assert.ok(long.name.length < 255);
});

test("denied permission, malformed GIF and cancelled permission cannot create task folders", async () => {
  const denied = filesystem(); denied.environment.permission = "denied";
  await assert.rejects(saveTaskGif(denied.root, gif(), "movie.gif"), /разрешение на запись/);
  assert.equal(denied.root.children.size, 0);
  const invalid = filesystem();
  await assert.rejects(saveTaskGif(invalid.root, new Blob(["<html>fake</html>"]), "movie.gif"), /GIF87a/);
  assert.equal(invalid.root.children.size, 0);
  const f = filesystem(), permission = deferred(), abort = new AbortController();
  f.environment.permission = permission.promise;
  const pending = saveTaskGif(f.root, gif(), "movie.gif", { signal: abort.signal });
  abort.abort(); permission.resolve("granted");
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(f.root.children.size, 0);
});

test("write/createWritable/close failures abort the stream and remove only the newly created file", async () => {
  for (const operation of ["createWritable", "write", "close"]) {
    const f = filesystem(); const original = f.file("output3XX/demo/existing.gif");
    let notifications = 0; const unsubscribe = subscribeTaskGifs(() => notifications++);
    f.environment.hook = call => { if (call.operation === operation) throw new Error(`${operation} failed`); };
    try {
      await assert.rejects(saveTaskGif(f.root, gif(), "new.gif"), new RegExp(`${operation} failed`));
      assert.equal(f.directory("output3XX/demo").children.get("existing.gif"), original);
      assert.equal(f.directory("output3XX/demo").children.has("new.gif"), false);
      if (operation !== "createWritable") assert.equal(f.environment.streams[0].aborted, true);
      assert.equal(notifications, 0);
      assert.ok(f.environment.calls.filter(call => call.operation === "remove").every(call => call.options.recursive === false));
    } finally { unsubscribe(); }
  }
});

test("abort after asynchronous write starts removes the new file and does not emit success", async () => {
  const f = filesystem(), abort = new AbortController(); let notifications = 0;
  const unsubscribe = subscribeTaskGifs(() => notifications++);
  f.environment.hook = call => { if (call.operation === "write") abort.abort(); };
  try {
    await assert.rejects(saveTaskGif(f.root, gif(), "cancelled.gif", { signal: abort.signal }), { name: "AbortError" });
    assert.equal(f.directory("output3XX/demo").children.size, 0);
    assert.equal(f.environment.streams[0].aborted, true); assert.equal(notifications, 0);
  } finally { unsubscribe(); }
});

test("cleanup preserves a nonempty external replacement at the same locator and reports removal failure", async () => {
  const replaced = filesystem(); let replacement;
  replaced.environment.hook = call => {
    if (call.operation === "write") { replacement = replaced.file("output3XX/demo/new.gif", gif("GIF87a")); throw new Error("write failed"); }
  };
  await assert.rejects(saveTaskGif(replaced.root, gif(), "new.gif"), /write failed/);
  assert.equal(replaced.directory("output3XX/demo").children.get("new.gif"), replacement);
  assert.equal(replaced.environment.calls.some(call => call.operation === "remove"), false);
  const blocked = filesystem();
  blocked.environment.hook = call => {
    if (call.operation === "write") throw new Error("write failed");
    if (call.operation === "remove") throw new Error("removal denied");
  };
  await assert.rejects(saveTaskGif(blocked.root, gif(), "new.gif"), /Не удалось убрать незавершённый GIF/);
});

test("cleanup preserves an empty file whose last-modified metadata has changed", async () => {
  const f = filesystem(); let replacement;
  f.environment.hook = call => {
    if (call.operation === "write") { replacement = f.file("output3XX/demo/new.gif", new Blob()); throw new Error("write failed"); }
  };
  await assert.rejects(saveTaskGif(f.root, gif(), "new.gif"), /файл изменился/);
  assert.equal(f.directory("output3XX/demo").children.get("new.gif"), replacement);
  assert.equal(f.environment.calls.some(call => call.operation === "remove"), false);
});

test("a failure to inspect the just-created entry names the possible leftover without unsafe deletion", async () => {
  const f = filesystem();
  f.environment.hook = call => { if (call.operation === "getFile") throw new Error("inspection denied"); };
  await assert.rejects(saveTaskGif(f.root, gif(), "unverified.gif"), /«unverified\.gif».*остался пустой файл.*inspection denied/);
  assert.equal(f.directory("output3XX/demo").children.get("unverified.gif").blob.size, 0);
  assert.equal(f.environment.calls.some(call => ["createWritable", "remove"].includes(call.operation)), false);
});

test("a cancellation after close commits preserves the saved GIF and refreshes observers", async () => {
  const f = filesystem(), abort = new AbortController(); let notifications = 0;
  const unsubscribe = subscribeTaskGifs(() => notifications++);
  f.environment.hook = call => { if (call.operation === "committed") abort.abort(); };
  try {
    await assert.rejects(saveTaskGif(f.root, gif(), "committed.gif", { signal: abort.signal }), { name: "AbortError" });
    const saved = f.directory("output3XX/demo").children.get("committed.gif");
    assert.equal(await saved.blob.slice(0, 6).text(), "GIF89a");
    assert.equal(f.environment.calls.some(call => call.operation === "remove"), false);
    assert.equal(notifications, 1);
  } finally { unsubscribe(); }
});

test("a file appearing before create is preserved and causes a free suffix to be chosen", async () => {
  const f = filesystem(); let injected;
  f.environment.hook = call => {
    if (call.operation === "file" && call.name === "movie.gif" && call.options.create === true && !injected) {
      injected = f.file("output3XX/demo/movie.gif", gif("GIF87a"));
    }
  };
  const saved = await saveTaskGif(f.root, gif(), "movie.gif");
  assert.equal(saved.name, "movie_2.gif"); assert.equal(await injected.blob.slice(0, 6).text(), "GIF87a");
});

test("deletion is permission-gated, scoped to the selected task's GIF and checks handle identity", async () => {
  const f = filesystem();
  const chosen = f.file("output3XX/demo/chosen.gif"), untouched = f.file("output3XX/demo/other.gif"), input = f.file("input3XX/input.gif");
  let notifications = 0; const unsubscribe = subscribeTaskGifs(() => notifications++);
  try {
    const pending = deleteTaskGif(f.root, { name: chosen.name, handle: chosen });
    assert.equal(f.environment.calls[0].operation, "permission"); await pending;
    assert.equal(f.directory("output3XX/demo").children.has("chosen.gif"), false);
    assert.equal(f.directory("output3XX/demo").children.get("other.gif"), untouched);
    assert.equal(f.directory("input3XX").children.get("input.gif"), input); assert.equal(notifications, 1);
    await assert.rejects(deleteTaskGif(f.root, { name: "other.gif", handle: input }), /был заменён/);
    await assert.rejects(deleteTaskGif(f.root, { name: "../input3XX/input.gif", handle: input }), /только выбранный GIF/);
    await assert.rejects(deleteTaskGif(f.root, { name: "other.txt", handle: untouched }), /только выбранный GIF/);
    assert.ok(f.environment.calls.filter(call => call.operation === "remove").every(call => call.options.recursive === false));
  } finally { unsubscribe(); }
});

test("delete cancellation after an awaited identity check cannot remove the file", async () => {
  const f = filesystem(), chosen = f.file("output3XX/demo/chosen.gif"), abort = new AbortController();
  f.environment.hook = call => { if (call.operation === "same") abort.abort(); };
  await assert.rejects(deleteTaskGif(f.root, { name: chosen.name, handle: chosen }, { signal: abort.signal }), { name: "AbortError" });
  assert.equal(f.directory("output3XX/demo").children.get(chosen.name), chosen);
  assert.equal(f.environment.calls.some(call => call.operation === "remove"), false);
});

test("read permission and other filesystem errors stay visible; cancelled reads do not publish stale files", async () => {
  const f = filesystem(); f.environment.hook = call => { if (call.operation === "directory") throw fsError("NotAllowedError", "reading denied"); };
  await assert.rejects(listTaskGifs(f.root), /reading denied/);
  const read = filesystem(), handle = read.file("output3XX/demo/read.gif"), abort = new AbortController();
  read.environment.hook = call => { if (call.operation === "getFile") abort.abort(); };
  await assert.rejects(readTaskGif(handle, { signal: abort.signal }), { name: "AbortError" });
});
