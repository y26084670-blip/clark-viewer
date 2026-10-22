import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createChangeNotifications, compareVersions, validateUpdatesFeed, safeUpdateUrl, updatesFeedUrl,
  NEWS_CACHE_KEY, installedVersionSnapshot, findVersionContext, createVersionCheckRequest, waitForVersionCheck,
  saveInstalledVersion, readSavedInstalledVersion } from "../src/services/changeNotifications.js";

const entry = (id, category = "interface", extra = {}) => ({ id, category, revision: 1, release: "new", date: "2026-10-22", title: id, summary: "Text", ...extra });
const feed = entries => ({ schemaVersion: 1, recommendedClark: null, entries });
const response = body => ({ ok: true, json: async () => body });
const memory = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const directory = files => ({ async getFileHandle(name) {
  if (!files.has(name)) throw new DOMException("missing", "NotFoundError");
  return { async getFile() { return { async text() { return files.get(name); } }; } };
} });
const workspaceId = "11111111-1111-4111-8111-111111111111";

test("package versions compare numerically, including large patch numbers; unknown stays unknown", () => {
  assert.equal(compareVersions("0.10.9", "0.10.10"), -1);
  assert.equal(compareVersions("1.0.0", "0.999.999"), 1);
  assert.equal(compareVersions("0.10.47", "0.10.47"), 0);
  assert.equal(compareVersions("1.2.999999999999999999", "1.2.1000000000000000000"), -1);
  for (const bad of [null, "1.2", "1.2.3-beta", "v1.2.3", 123, "1.2.3.4"]) assert.equal(compareVersions(bad, "1.2.3"), null);
});

test("both applications address one registry and permit only web links", () => {
  assert.equal(updatesFeedUrl("editor", "/clark-editor/", "https://example.test/clark-editor/"), "https://example.test/clark-editor/updates.json");
  assert.equal(updatesFeedUrl("viewer", "/clark-viewer/", "https://example.test/clark-viewer/"), "https://example.test/clark-editor/updates.json");
  assert.equal(safeUpdateUrl("user-guide/index.html#help", "https://example.test/clark-editor/updates.json"), "https://example.test/clark-editor/user-guide/index.html#help");
  assert.equal(safeUpdateUrl("javascript:alert(1)"), null);
  assert.equal(safeUpdateUrl("file:///C:/clark.app"), null);
});

test("invalid registries never replace usable data", () => {
  const one = entry("one");
  for (const bad of [{}, feed([one, one]), feed([entry("wrong", "unknown")]), feed([entry("wrong", "interface", { revision: 0 })]),
    { ...feed([]), recommendedClark: { version: "0.10", installerUrl: "https://example.test/installer" } }]) {
    assert.throws(() => validateUpdatesFeed(bad));
  }
});

test("first use starts with the latest release separately in each category", async () => {
  const data = feed([entry("i-old", "interface", { date: "2026-10-20", release: "old" }), entry("i-new"), entry("i-new2"),
    entry("c-old", "computation", { date: "2026-10-19", release: "old" }), entry("c-new", "computation")]);
  const store = createChangeNotifications({ storage: memory(), fetchImpl: async () => response(data) });
  await store.refresh();
  assert.equal(store.unread("interface"), 2); assert.equal(store.unread("computation"), 1);
  assert.equal(store.snapshot().feed.entries.length, 5);
  store.dispose();
});

test("opening a journal never acknowledges it; per-category acknowledgement survives reopening", async () => {
  const storage = memory(), data = feed([entry("ui"), entry("math", "computation")]);
  const first = createChangeNotifications({ storage, fetchImpl: async () => response(data) });
  await first.refresh(); assert.equal(first.unread(), 2);
  first.snapshot(); assert.equal(first.unread(), 2);
  first.markRead(first.snapshot().feed.entries.filter(item => item.category === "interface")); first.dispose();
  const next = createChangeNotifications({ storage });
  assert.equal(next.unread("interface"), 0); assert.equal(next.unread("computation"), 1);
  next.dispose();
});

test("simultaneous acknowledgements in two pages do not overwrite one another", async () => {
  const storage = memory(), target = new EventTarget(), data = feed([entry("a"), entry("b", "computation")]);
  let updates = 0;
  const a = createChangeNotifications({ storage, eventTarget: target, fetchImpl: async () => response(data) });
  await a.refresh();
  const b = createChangeNotifications({ storage, eventTarget: target, onChange: () => updates++ });
  a.markRead([data.entries[0]]); b.markRead([data.entries[1]]);
  assert.equal(a.unread(), 0); assert.equal(b.unread(), 0); assert.ok(updates > 0);
  a.dispose(); b.dispose();
});

test("a missed release and a substantive revision become unread again without package-version resets", async () => {
  let data = feed([entry("a")]);
  const store = createChangeNotifications({ storage: memory(), fetchImpl: async () => response(data) });
  await store.refresh(); store.markRead(data.entries);
  data = feed([entry("a", "interface", { revision: 2 }), entry("b"), entry("c", "computation")]);
  await store.refresh(); assert.equal(store.unread(), 3); store.dispose();
});

test("offline and bad responses preserve the last validated registry and time", async () => {
  let fail = false;
  const store = createChangeNotifications({ storage: memory(), now: () => Date.parse("2026-10-22T20:00:00Z"),
    fetchImpl: async () => fail ? response({ broken: true }) : response(feed([entry("a")])) });
  await store.refresh(); const checkedAt = store.snapshot().checkedAt;
  fail = true; await store.refresh();
  assert.equal(store.unread(), 1); assert.equal(store.snapshot().checkedAt, checkedAt);
  assert.equal(store.snapshot().source, "cache"); assert.match(store.snapshot().error, /сохранённая/);
  store.dispose();
});

test("corrupt cache, unavailable storage, and synchronous network failure leave the app usable", async () => {
  const storage = memory(); storage.setItem(NEWS_CACHE_KEY, "broken");
  let calls = 0;
  const store = createChangeNotifications({ storage, fetchImpl: () => { calls++; throw new Error("offline"); } });
  await store.refresh(); await store.refresh(); assert.equal(calls, 2);
  assert.equal(store.snapshot().source, "none"); store.dispose();
  const disabled = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const fallback = createChangeNotifications({ storage: disabled, fetchImpl: async () => response(feed([entry("a")])) });
  await fallback.refresh(); fallback.markRead(fallback.snapshot().feed.entries);
  assert.equal(fallback.unread(), 0); assert.equal(fallback.snapshot().persistent, false); fallback.dispose();
});

test("a disposed controller cancels its fetch and publishes no late state", async () => {
  let count = 0, cancel;
  const store = createChangeNotifications({ storage: memory(), onChange: () => count++, fetchImpl: (_, { signal }) =>
    new Promise((resolve, reject) => { cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); }) });
  const pending = store.refresh(); store.dispose(); const before = count; await pending;
  assert.equal(count, before);
});

test("native version is discovered from bound catalogs without creating files or asking permission", async () => {
  const files = new Map([["clark.workspace.json", JSON.stringify({ schemaVersion: 1, bindingState: "bound", workspaceId,
    launchOptionsVersion: 1, appVersion: "0.10.47", appVersionCheckedAt: "2026-10-22T20:00:00Z" })]]);
  const root = directory(files);
  const context = await findVersionContext([{ handle: directory(new Map()) }, { handle: root }]);
  assert.equal(context.root, root); assert.equal(context.installed.version, "0.10.47"); assert.equal(files.size, 1);
  const request = createVersionCheckRequest(context);
  assert.match(request.uri, /^clark:\/\/settings\?workspace=/); assert.equal(request.workspaceId, workspaceId);
  assert.equal(createVersionCheckRequest(null), null);
  assert.equal(createVersionCheckRequest({ binding: { launchOptionsVersion: 0 } }), null);
  assert.equal(await findVersionContext([{ handle: directory(new Map([["clark.workspace.json", JSON.stringify({ schemaVersion: 1, bindingState: "bound", workspaceId: "00000000-0000-0000-0000-000000000000" })]])) }]), null);
});

test("native acknowledgement must match the request; old handlers report unknown, not a guessed version", async () => {
  const files = new Map(), request = { root: directory(files), requestId: "request", workspaceId };
  const result = { schemaVersion: 1, requestId: "other", workspaceId, appVersion: "0.10.47", appVersionCheckedAt: "2026-10-22T20:00:00Z" };
  files.set("clark.settings.json", JSON.stringify(result));
  await assert.rejects(waitForVersionCheck(request, { timeoutMs: 2, intervalMs: 3 }), /не ответил/);
  result.requestId = request.requestId; files.set("clark.settings.json", JSON.stringify(result));
  assert.equal((await waitForVersionCheck(request)).version, "0.10.47");
  delete result.appVersion; files.set("clark.settings.json", JSON.stringify(result));
  assert.equal(await waitForVersionCheck(request), null);
  assert.equal(installedVersionSnapshot({ appVersion: "0.10.47", appVersionCheckedAt: "bad" }), null);
});

test("native waiting cancels immediately when the dialog closes", async () => {
  const controller = new AbortController();
  const operation = waitForVersionCheck({ root: directory(new Map()), requestId: "x", workspaceId }, { signal: controller.signal });
  controller.abort(); await assert.rejects(operation, { name: "AbortError" });
});

test("last successful version snapshot persists and can be invalidated after an unknown response", () => {
  const storage = memory(), value = { version: "0.10.47", checkedAt: "2026-10-22T20:00:00Z" };
  saveInstalledVersion(storage, value); assert.deepEqual(readSavedInstalledVersion(storage), value);
  saveInstalledVersion(storage, null); assert.equal(readSavedInstalledVersion(storage), null);
});

test("published guide links and canonical registry are valid when present in the owning repository", async () => {
  const path = new URL("../data/updates/changes.json", import.meta.url);
  let json;
  try { json = await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const data = validateUpdatesFeed(JSON.parse(json));
  const guide = await readFile(new URL("../docs/user-guide/index.html", import.meta.url), "utf8");
  for (const item of data.entries) if (item.detailsUrl?.startsWith("user-guide/index.html#")) {
    assert.ok(guide.includes(`id="${item.detailsUrl.split("#")[1]}"`));
  }
});
