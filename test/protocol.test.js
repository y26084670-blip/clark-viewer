import test from "node:test";
import assert from "node:assert/strict";
import { appendProtocolBlocks, newProtocol, parseProtocol, serializeProtocol } from "../src/services/protocol/protocolDocument.js";
import { createTaskProtocol, protocolFilename, readTaskProtocol, saveTaskProtocol } from "../src/services/protocol/taskProtocolService.js";
import { captureProtocolRenderer } from "../src/services/protocol/protocolCapture.js";

const image = id => ({ id, kind: "image", title: "Поле", comment: "Шаг 2", width: 1, height: 1,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

test("a protocol survives a later session: comments, removals, additions and original block identity", () => {
  const first = newProtocol("Root/Project/Task", [image("old"), image("delete")], "2026-01-01T00:00:00.000Z");
  const reopened = parseProtocol(serializeProtocol(first));
  reopened.blocks = reopened.blocks.filter(block => block.id !== "delete");
  reopened.blocks[0].comment = "Позднее уточнение";
  const amended = appendProtocolBlocks(reopened, [image("old"), image("new"), image("new")]);
  const persisted = parseProtocol(serializeProtocol(amended));
  assert.equal(persisted.id, first.id); assert.equal(persisted.createdAt, first.createdAt);
  assert.deepEqual(persisted.blocks.map(block => block.id), ["old", "new"]);
  assert.equal(persisted.blocks[0].dataUrl, first.blocks[0].dataUrl);
  assert.equal(persisted.blocks[0].comment, "Позднее уточнение");
});

test("standalone HTML escapes conditions, names and comments; its data never becomes executable", () => {
  const attack = '</script><script>window.injected=true</script><img src=x onerror="alert(1)">';
  const doc = newProtocol(attack, [{ id: "conditions", kind: "text", title: attack, comment: attack, text: attack },
    { id: "values", kind: "table", title: "Значения", comment: "", table: { headers: ["M"], rows: [[attack]] } }, image("png")]);
  const html = serializeProtocol(doc);
  assert.deepEqual(parseProtocol(html), doc);
  assert.equal(html.includes('<script>window.injected'), false);
  assert.equal((html.match(/<script /g) ?? []).length, 1);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.throws(() => serializeProtocol({ ...doc, blocks: [{ ...image("bad"), dataUrl: "https://example.com/image.png" }] }), /изображение/);
  assert.throws(() => serializeProtocol({ ...doc, blocks: [image("duplicate"), image("duplicate")] }), /блок/);
  assert.throws(() => parseProtocol("<h1>Unrelated file</h1>"), /не содержит/);
  assert.throws(() => serializeProtocol({ ...doc, version: 2 }), /версии 1/);
});

function filesystem() {
  const files = new Map(), dirs = new Set(["", "output3XX"]), writes = [];
  let permission = "granted", failWrite = false;
  const notFound = () => new DOMException("missing", "NotFoundError");
  function directory(path) {
    return { kind: "directory", name: path.split("/").at(-1) || "Task",
      async requestPermission() { return permission; },
      async getDirectoryHandle(name, { create = false } = {}) {
        const key = [path, name].filter(Boolean).join("/");
        if (!dirs.has(key) && !create) throw notFound();
        dirs.add(key); return directory(key);
      },
      async getFileHandle(name, { create = false } = {}) {
        const key = [path, name].filter(Boolean).join("/");
        if (!files.has(key)) { if (!create) throw notFound(); files.set(key, ""); }
        return { kind: "file", name, key, async isSameEntry(other) { return key === other.key; }, async getFile() { return new Blob([files.get(key)]); },
          async createWritable() { let data; return {
            async write(value) { data = value; if (failWrite) throw new Error("disk full"); },
            async close() { files.set(key, data); writes.push(key); }, async abort() { writes.push("aborted"); },
          }; } };
      },
      async removeEntry(name) { files.delete([path, name].filter(Boolean).join("/")); },
      async *entries() { for (const key of files.keys()) if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")) {
        const name = key.slice(path.length + 1); yield [name, await this.getFileHandle(name)];
      } },
    };
  }
  return { files, dirs, writes, task: { handle: directory(""), plotLabel: "Root/Project/Task" },
    permission: value => { permission = value; }, failWrite: () => { failWrite = true; } };
}

test("DOCS is created only on save; optional conditions are literal, missing output is allowed", async () => {
  const fs = filesystem(); fs.files.set("output3XX/conditions.json", '{"MPI": 4}\n');
  const doc = await createTaskProtocol(fs.task);
  assert.equal(doc.blocks[0].text, '{"MPI": 4}\n');
  assert.equal(fs.dirs.has("DOCS"), false); assert.equal(await readTaskProtocol(fs.task, "protocol.html"), null);
  const saved = await saveTaskProtocol(fs.task, "protocol.html", doc, null);
  assert.equal(fs.dirs.has("DOCS"), true);
  assert.deepEqual((await readTaskProtocol(fs.task, saved.name)).document, saved.document);
  fs.dirs.delete("output3XX"); assert.deepEqual((await createTaskProtocol(fs.task)).blocks, []);
});

test("existing or externally changed files cannot be overwritten silently; denied and failed writes preserve old data", async () => {
  const fs = filesystem(), doc = newProtocol("Task", [image("a")]);
  const saved = await saveTaskProtocol(fs.task, "p.html", doc, null);
  await assert.rejects(saveTaskProtocol(fs.task, "p.html", doc, null), /уже существует/);
  fs.files.set("DOCS/p.html", saved.html + "\n");
  await assert.rejects(saveTaskProtocol(fs.task, "p.html", doc, saved.html), /изменён/);
  fs.files.set("DOCS/foreign.html", "Human document");
  await assert.rejects(saveTaskProtocol(fs.task, "foreign.html", doc, null), /не содержит/);
  fs.permission("denied");
  await assert.rejects(saveTaskProtocol(fs.task, "new.html", doc, null), /Разрешите/);
  assert.equal(fs.files.has("DOCS/new.html"), false);
  fs.permission("granted"); fs.failWrite();
  await assert.rejects(saveTaskProtocol(fs.task, "p.html", doc, saved.html + "\n"), /disk full/);
  assert.equal(fs.files.get("DOCS/p.html"), saved.html + "\n"); assert.equal(fs.writes.at(-1), "aborted");
  await assert.rejects(saveTaskProtocol(fs.task, "new.html", doc, null), /disk full/);
  assert.equal(fs.files.has("DOCS/new.html"), false);
  for (const name of ["../a.html", "CON.html", "a.txt", "a/b.html", "a.html ".trimEnd() + "."]) assert.throws(() => protocolFilename(name));
});

test("renderer export restores the chart on capture failure", async () => {
  const calls = [], renderer = { renderReady: async () => calls.push("ready"), prepare: async () => calls.push("prepare"),
    capture: () => { throw new Error("lost context"); }, restore: async () => calls.push("restore") };
  await assert.rejects(captureProtocolRenderer(renderer, {}, {}), /lost context/);
  assert.deepEqual(calls, ["ready", "prepare", "restore"]);
});
