import test from "node:test";
import assert from "node:assert/strict";
import { buildCloudCatalogs, readZoneReport } from "../src/services/cloudExamples.js";
import { listTaskProtocolDownloads } from "../src/services/protocol/protocolDownloads.js";

const catalog = { directory: "clark.tests", name: "clark.tests_cloud" };
const prefix = catalog.directory + "/Тест/Задача/";
const entry = path => ({ path, type: "file", size: 3 });
const manifest = entries => ({ version: 1, baseUrl: "examples/", catalogs: [catalog], entries });
const url = "https://site.test/clark-editor/cloud-examples.json";

test("catalog aliases, read-only preview, exact file URLs and lazy protocol metadata", async () => {
  const urls = [], leaf = "a #=%.html";
  const [cloud] = buildCloudCatalogs(manifest([entry(prefix + "DOCS/" + leaf)]), url, async function (address) {
    assert.equal(this, undefined);
    urls.push(address);
    return new Response("abc");
  });
  assert.equal(cloud.name, catalog.name);
  assert.equal(cloud.id, "cloud:" + catalog.directory);
  const project = await cloud.handle.getDirectoryHandle("Тест");
  const task = await project.getDirectoryHandle("Задача");
  const docs = await task.getDirectoryHandle("docs");
  const [protocol] = await listTaskProtocolDownloads(task);
  assert.equal(protocol.size, 3);
  assert.deepEqual(urls, []);
  const handle = await docs.getFileHandle(leaf);
  assert.equal(await (await handle.getFile()).text(), "abc");
  assert.deepEqual(urls, [new URL("examples/" + (prefix + "DOCS/" + leaf).split("/").map(encodeURIComponent).join("/"), url).href]);
  await assert.rejects(docs.getFileHandle(leaf, { create: true }), { name: "NotAllowedError" });
  await assert.rejects(handle.createWritable(), { name: "NotAllowedError" });
  await assert.rejects(docs.removeEntry(leaf), { name: "NotAllowedError" });
});

test("traversal, conflicting names and aliases are rejected before fetching", () => {
  for (const path of ["../outside", "a/b\\c", "D:/path", "CON.txt", "a./f"]) {
    assert.throws(() => buildCloudCatalogs(manifest([entry(prefix + path)]), url));
  }
  assert.throws(() => buildCloudCatalogs(manifest([entry(prefix + "A"), entry(prefix + "a")]), url));
  assert.throws(() => buildCloudCatalogs({ ...manifest([]), catalogs: [catalog] }, url));
});

test("a local task is marked red only after a positive native report", async () => {
  const handle = { getFileHandle: async () => ({ getFile: async () => new File([
    JSON.stringify({ version: 1, blocked: ["Проект/Тест"], unknown: ["Проект/Другой"] }),
  ], "clark.file-zones.json") }) };
  assert.deepEqual([...(await readZoneReport(handle)).blocked], ["проект/тест"]);
  assert.equal((await readZoneReport({ ...handle, cloud: true })).blocked.size, 0);
  assert.equal((await readZoneReport(null)).blocked.size, 0);
});
