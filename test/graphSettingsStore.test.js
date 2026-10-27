import test from "node:test";
import assert from "node:assert/strict";
import { createGraphSettingsStore, GRAPH_SETTINGS_FILE, normalizeGraphSettings } from "../src/services/results/graphSettingsStore.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";

function disk(initial) {
  let text = initial, writes = 0, active = 0, maximum = 0, fail = false;
  const handle = { async getFileHandle(name, options) {
    assert.equal(name, GRAPH_SETTINGS_FILE);
    if (text === undefined && !options?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    return { async getFile() { return { text: async () => text, size: text?.length ?? 0 }; }, async createWritable() {
      if (fail) throw new Error("read only");
      let next; active++; maximum = Math.max(maximum, active);
      return { async write(value) { next = value; await new Promise(resolve => setTimeout(resolve, 2)); }, async close() { text = next; writes++; active--; }, async abort() { active--; } };
    } };
  } };
  return { handle, text: () => text, writes: () => writes, maximum: () => maximum, fail: () => fail = true };
}
const settings = { only: true, areas: true, showSlices: true, active: 4,
  slices: [{ id: 4, recordIndex: 0, direction: 2, discrete: 2, component: 1 }],
  profiles: [{ id: 8, graphId: 4, instanceKey: "elements:0:0:0:1:0:0", direction: 0, index: 2,
    view: { autoScale: false, showLegend: false, hidden: ["Y"], limits: { xMin: 2, xMax: 17, yMin: -9, yMax: 28 }, legendPosition: { x: .3, y: .8 }, windowSize: { width: 1180, height: 720 } } }],
  activeProfile: 8, expandedProfile: 8, view: { resultVectorScale: 3.25, resultPalette: "Turbo", resultElementsQuantity: "J", showPeriodicSymmetry: true }, selections: { elements: [1], regions: [1] } };

test("settings, collection, selected image and chart view survive a fresh task object and directory reopen", async () => {
  const f = graph3DTask(), d = disk(); f.task.handle = d.handle;
  const store = createGraphSettingsStore(f.task); assert.equal(await store.ready, null);
  store.save(settings); await store.flush(); await store.dispose(); assert.equal(d.writes(), 1);
  const task = { ...graph3DTask().task, handle: d.handle }, restored = createGraphSettingsStore(task);
  const saved = await restored.ready;
  assert.equal(saved.view.resultVectorScale, 3.25); assert.deepEqual(saved.slices, settings.slices);
  assert.deepEqual(saved.profiles[0].view, settings.profiles[0].view); assert.equal(saved.expandedProfile, 8);
  assert.deepEqual(saved.selections, settings.selections); await restored.dispose();
});

test("rapid changes coalesce; writes serialize across remount and dispose flushes the final change", async () => {
  const d = disk(), task = { ...graph3DTask().task, handle: d.handle }, store = createGraphSettingsStore(task);
  await store.ready;
  for (let n = 0; n < 20; n++) store.save({ ...settings, activeProfile: n });
  const first = store.flush(); store.save({ ...settings, only: false }); const closing = store.dispose();
  const next = createGraphSettingsStore(task); const restored = await next.ready;
  assert.equal(restored.only, false); assert.equal(d.maximum(), 1); assert.equal(d.writes(), 2);
  await Promise.all([first, closing]); await next.dispose();
});

test("legacy hidden quantities become hidden groups and preserve the saved collection", async () => {
  const previous = { ...settings, view: { ...settings.view, resultElementsQuantity: "none", resultRegionsQuantity: "none",
    resultVirtualQuantity: "Av", elementsMode: "selected", regionsMode: "all" } };
  const d = disk(JSON.stringify({ version: 1, settings: previous }));
  const store = createGraphSettingsStore({ ...graph3DTask().task, handle: d.handle });
  const restored = await store.ready;
  assert.equal(restored.view.resultElementsQuantity, "M"); assert.equal(restored.view.resultRegionsQuantity, "Bs");
  assert.equal(restored.view.elementsMode, "none"); assert.equal(restored.view.regionsMode, "none");
  assert.equal(restored.view.resultVirtualQuantity, "Av"); assert.equal(restored.profiles.length, 1);
  assert.equal(restored.profiles[0].id, settings.profiles[0].id);
  assert.deepEqual(restored.profiles[0].view, settings.profiles[0].view);
  store.save(restored); await store.flush(); await store.dispose();
  const reopened = createGraphSettingsStore({ ...graph3DTask().task, handle: d.handle });
  assert.deepEqual(await reopened.ready, restored); await reopened.dispose();
});

test("corrupt, unsupported and read-only files give a notice and never silently replace the previous file", async () => {
  for (const original of ["broken JSON", JSON.stringify({ version: 2, settings })]) {
    const d = disk(original), messages = [], store = createGraphSettingsStore({ ...graph3DTask().task, handle: d.handle }, { onNotice: text => messages.push(text) });
    assert.equal(await store.ready, null); store.save(settings); await store.flush();
    assert.equal(d.text(), original); assert.equal(d.writes(), 0); assert.ok(messages.some(Boolean)); await store.dispose();
  }
  const original = JSON.stringify({ version: 1, settings }), d = disk(original), messages = [];
  const store = createGraphSettingsStore({ ...graph3DTask().task, handle: d.handle }, { onNotice: text => messages.push(text) });
  await store.ready; d.fail(); store.save({ ...settings, only: false }); await store.flush();
  assert.equal(d.text(), original); assert.match(messages.at(-1), /Не удалось сохранить/); await store.dispose();
});

test("stale slices/profiles and out-of-range indices are filtered against the current discretization", () => {
  const f = graph3DTask(), saved = structuredClone(settings);
  saved.slices.push({ ...saved.slices[0], id: 9, discrete: 3 });
  saved.profiles.push({ ...saved.profiles[0], id: 9, index: 3 }, { ...saved.profiles[0], id: 10, graphId: 9 });
  saved.profiles.push({ id: 11, graphId: "region:0", instanceKey: "regions:0:0:0:0:0:0", direction: 0, index: 4 });
  const normalized = normalizeGraphSettings({ version: 1, settings: saved }, f.task);
  assert.equal(normalized.slices.length, 1); assert.equal(normalized.profiles.length, 1);
});
