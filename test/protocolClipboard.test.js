import test from "node:test";
import assert from "node:assert/strict";
import { protocolClipboardImage, readProtocolClipboard } from "../src/services/protocol/protocolClipboard.js";
import { appendProtocolBlocks, newProtocol, parseProtocol, serializeProtocol } from "../src/services/protocol/protocolDocument.js";

const png = "data:image/png;base64,AQID";
const bitmapFixture = (changes = {}) => {
  let closed = 0, drawn = 0;
  const bitmap = { width: 640, height: 320, close() { closed++; }, ...changes };
  const canvas = { getContext: () => ({ drawImage(value) { assert.equal(value, bitmap); drawn++; } }), toDataURL: type => { assert.equal(type, "image/png"); return png; } };
  return { bitmap, canvas, options: { decode: async () => bitmap, createCanvas: () => canvas }, closed: () => closed, drawn: () => drawn };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("text preserves lines, spaces and literal HTML through saving and reopening", async () => {
  const text = '  Строка 1\n\n<script>window.injected = true</script>\n<&>\tстрока 2  ';
  const block = await readProtocolClipboard("text", { clipboard: { readText: async () => text } });
  const html = serializeProtocol(newProtocol("Project/Task", [block]));
  assert.equal(block.text, text); assert.equal(block.comment, "");
  assert.ok(!html.includes('<script>window.injected = true</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.deepEqual(parseProtocol(html).blocks, [block]);
});

test("repeated pastes remain separate and are inserted after summaries before animations", async () => {
  const clipboard = { readText: async () => "Комментарий расчёта" };
  const first = await readProtocolClipboard("text", { clipboard }), second = await readProtocolClipboard("text", { clipboard });
  assert.notEqual(first.id, second.id);
  const summary = { id: "summary", kind: "text", source: "summary", title: "Сводка", comment: "", text: "summary" };
  const docs = { id: "docs", kind: "text", source: "docs", title: "README", comment: "", text: "original" };
  const video = { id: "movie", kind: "video", filename: "clip.webm", title: "Видео", comment: "", dataUrl: "data:video/webm;base64,AQID" };
  const original = newProtocol("Task", [summary, docs, video]);
  const amended = appendProtocolBlocks(appendProtocolBlocks(original, [first]), [second]);
  assert.deepEqual(amended.blocks, [summary, first, second, docs, video]);
  assert.deepEqual(original.blocks, [summary, docs, video]);
  assert.deepEqual(appendProtocolBlocks(newProtocol("Task"), [first]).blocks, [first]);
});

test("clipboard reads start synchronously in the click activation", async () => {
  for (const kind of ["text", "image"]) {
    let called = false;
    const clipboard = { readText: () => { called = true; return Promise.resolve("text"); },
      read: () => { called = true; return Promise.resolve([]); } };
    const operation = readProtocolClipboard(kind, { clipboard });
    assert.equal(called, true);
    if (kind === "image") await assert.rejects(operation, /нет рисунка/); else await operation;
  }
});

test("image representation is preferred to HTML/text and preserves bitmap dimensions", async () => {
  const fixture = bitmapFixture(), blob = new Blob(["jpeg data"], { type: "image/jpeg" });
  const clipboard = { read: async () => [{ types: ["text/html", "text/plain"] }, { types: ["text/html", "image/jpeg"], getType: async type => { assert.equal(type, "image/jpeg"); return blob; } }] };
  const block = await readProtocolClipboard("image", { clipboard, image: (value, { signal }) => {
    assert.equal(value, blob); return protocolClipboardImage(value, { ...fixture.options, signal });
  } });
  assert.equal(block.kind, "image"); assert.equal(block.width, 640); assert.equal(block.height, 320); assert.equal(block.dataUrl, png);
  assert.equal(fixture.canvas.width, 640); assert.equal(fixture.canvas.height, 320);
  assert.equal(fixture.closed(), 1); assert.equal(fixture.drawn(), 1);
  assert.deepEqual(parseProtocol(serializeProtocol(newProtocol("Task", [block]))).blocks, [block]);
});

test("empty, non-image and unsupported clipboard states report errors", async () => {
  await assert.rejects(readProtocolClipboard("text", { clipboard: {} }), /недоступно/);
  await assert.rejects(readProtocolClipboard("image", { clipboard: {} }), /недоступно/);
  for (const text of ["", " \n\t"]) await assert.rejects(readProtocolClipboard("text", { clipboard: { readText: async () => text } }), /нет текста/);
  await assert.rejects(readProtocolClipboard("image", { clipboard: { read: async () => [{ types: ["text/html", "image/svg+xml"] }] } }), /нет рисунка/);
  await assert.rejects(readProtocolClipboard("video", { clipboard: {} }), /Неизвестный/);
});

test("denied clipboard access is actionable and never writes", async () => {
  for (const name of ["NotAllowedError", "SecurityError"]) for (const kind of ["image", "text"]) {
    const denied = async () => { throw new DOMException("denied", name); };
    await assert.rejects(readProtocolClipboard(kind, { clipboard: { read: denied, readText: denied, write: () => assert.fail("clipboard must not be written") } }), /Разрешите Viewer чтение/);
  }
  await assert.rejects(readProtocolClipboard("text", { clipboard: { readText: async () => { throw new DOMException("no text", "NotFoundError"); } } }), /нет текста/);
});

test("text size is bounded by UTF-8 bytes", async () => {
  await assert.rejects(readProtocolClipboard("text", { clipboard: { readText: async () => "я".repeat(1024 * 1024 + 1) } }), /2 МиБ/);
});

test("cancellation ignores delayed clipboard reads and does not decode their images", async () => {
  for (const kind of ["text", "image"]) {
    const waiting = deferred(), controller = new AbortController();
    const operation = readProtocolClipboard(kind, { signal: controller.signal,
      clipboard: { readText: () => waiting.promise, read: () => waiting.promise }, image: () => assert.fail("late image must not decode") });
    controller.abort(); waiting.resolve(kind === "text" ? "late text" : []);
    await assert.rejects(operation, { name: "AbortError" });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readProtocolClipboard("image", { signal: controller.signal, clipboard: { read: () => assert.fail("aborted request must not read") } }), { name: "AbortError" });
});

test("image size limits avoid canvas allocation and close decoded bitmaps", async () => {
  const blob = new Blob(["image"]);
  for (const width of [0, 8193, 1.5]) {
    const fixture = bitmapFixture({ width });
    await assert.rejects(protocolClipboardImage(blob, fixture.options), /8192/);
    assert.equal(fixture.closed(), 1); assert.equal(fixture.drawn(), 0);
  }
  await assert.rejects(protocolClipboardImage({ size: 16 * 1024 * 1024 + 1 }, { decode: () => assert.fail("large input must not decode") }), /слишком большой/);
  const fixture = bitmapFixture(); fixture.canvas.toDataURL = () => "x".repeat(16 * 1024 * 1024 + 1);
  await assert.rejects(protocolClipboardImage(blob, fixture.options), /слишком большой/);
  assert.equal(fixture.closed(), 1);
});

test("failed and cancelled decoding leaves no retained bitmap", async () => {
  const blob = new Blob(["image"]), controller = new AbortController(), waiting = deferred(), fixture = bitmapFixture();
  const operation = protocolClipboardImage(blob, { ...fixture.options, signal: controller.signal, decode: () => waiting.promise });
  controller.abort(); waiting.resolve(fixture.bitmap);
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(fixture.closed(), 1); assert.equal(fixture.drawn(), 0);
  await assert.rejects(protocolClipboardImage(blob, { decode: async () => { throw new Error("bad image"); } }), /Не удалось прочитать рисунок/);
  const broken = bitmapFixture(); broken.canvas.getContext = () => null;
  await assert.rejects(protocolClipboardImage(blob, broken.options), /не смог подготовить/);
  assert.equal(broken.closed(), 1);
});
