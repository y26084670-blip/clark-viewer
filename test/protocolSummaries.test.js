import test from "node:test";
import assert from "node:assert/strict";
import { readProtocolSummaries, trimResultFilesDescription } from "../src/services/protocol/protocolSummaries.js";
import { inputSummary, outputSummary } from "./fixtures/protocolScene.js";

function task(files) {
  const calls = [];
  return { calls, handle: { async getDirectoryHandle(directory, options) {
    calls.push(options); return { async getFileHandle(name, options) {
      calls.push(options);
      const value = files[`${directory}/${name}`];
      if (value === undefined) throw new DOMException("missing", "NotFoundError");
      return { getFile: async () => typeof value === "string" ? new Blob([value]) : value };
    } };
  } } };
}

test("summaries follow input/output order, preserve literal input and stop before the result-file description", async () => {
  const source = task({ "input3XX/_summary.txt": "\ufeff" + inputSummary, "output3XX/_summary_out.txt": outputSummary });
  const blocks = await readProtocolSummaries(source);
  assert.equal(blocks.length, 2); assert.equal(blocks[0].text, inputSummary);
  assert.equal(blocks[1].text, "Расчёт завершён\r\nИтераций: 17");
  assert.match(blocks[0].title, /input3XX\/_summary.txt/); assert.match(blocks[1].title, /output3XX\/_summary_out.txt/);
  assert.ok(blocks.every(block => block.source === "summary" && block.comment === ""));
  assert.ok(source.calls.every(options => options.create === false));
});

test("trimming supports CRLF, indentation and casing; absent marker retains the complete summary", () => {
  assert.equal(trimResultFilesDescription("ok\r\n  файлы результатов: details\r\nrest"), "ok");
  assert.equal(trimResultFilesDescription("Файлы результатов:\nrest"), "");
  assert.equal(trimResultFilesDescription("ok\nlast\n"), "ok\nlast\n");
});

test("missing summaries are optional; size/access/cancellation failures are explicit", async () => {
  assert.deepEqual(await readProtocolSummaries(task({})), []);
  await assert.rejects(readProtocolSummaries(task({ "input3XX/_summary.txt": { size: 2 * 1024 * 1024 + 1,
    text() { assert.fail("oversized text must not be read"); } } })), /2 МиБ/);
  await assert.rejects(readProtocolSummaries({ handle: { getDirectoryHandle() { throw new DOMException("denied", "NotAllowedError"); } } }), { name: "NotAllowedError" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readProtocolSummaries(task({}), { signal: controller.signal }), { name: "AbortError" });
});

test("a large discarded result-file description is neither read in full nor copied into the protocol", async () => {
  const source = new Blob(["Завершено\nФайлы результатов:\n", "details\n".repeat(400000)]);
  source.text = () => assert.fail("the complete result description must never be read");
  const [block] = await readProtocolSummaries(task({ "output3XX/_summary_out.txt": source }));
  assert.equal(block.text, "Завершено");
  await assert.rejects(readProtocolSummaries(task({ "output3XX/_summary_out.txt": new Blob(["x".repeat(2 * 1024 * 1024 + 1)]) })), /2 МиБ/);
});
