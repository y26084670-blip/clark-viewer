import test from "node:test";
import assert from "node:assert/strict";
import { createTaskStatusMonitor } from "../src/services/taskStatusMonitor.js";

const status = (hasSolution = false) => ({ hasSolution, missingInput: false, hasGifs: false, hasComparison: false, omState: "none", planar2D: false, errors: {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(read, concurrency = 6) {
  const published = [], busy = [];
  const monitor = createTaskStatusMonitor({ read, concurrency,
    onChange: value => published.push(value), onBusyChange: value => busy.push(value),
  });
  return { monitor, published, busy };
}

test("sources do not trigger reads; manual refresh updates only changed values", async () => {
  let value = status(), reads = 0;
  const f = fixture(async () => { reads++; return value; });
  try {
    const row = Object.freeze({ key: "task", path: "project/task", enabled: false });
    f.monitor.setSource([row]); await turn();
    assert.equal(reads, 0); assert.equal(f.published.length, 0);
    await f.monitor.refresh(); assert.equal(reads, 1); assert.equal(f.published.length, 1);
    value = status(true); await turn();
    assert.equal(reads, 1); assert.equal(f.published.at(-1).get("task").hasSolution, false);
    await f.monitor.refresh();
    assert.equal(f.published.at(-1).get("task").hasSolution, true);
    await f.monitor.refresh(); assert.equal(f.published.length, 2);
    value = { ...status(true), hasGifs: true }; await f.monitor.refresh();
    assert.equal(f.published.at(-1).get("task").hasGifs, true);
    value = status(); await f.monitor.refresh();
    assert.equal(f.published.at(-1).get("task").hasSolution, false);
    assert.equal(row.enabled, false); assert.equal(row.path, "project/task");
    assert.deepEqual(f.busy, [true, false, true, false, true, false, true, false, true, false]);
  } finally { f.monitor.dispose(); }
});

test("status checks do not install timers or focus/visibility/GIF handlers", async () => {
  let installed = 0, reads = 0;
  const eventTarget = new EventTarget(), documentTarget = new EventTarget();
  const monitor = createTaskStatusMonitor({ read: async () => { reads++; return status(); },
    eventTarget: { addEventListener() { installed++; } }, documentTarget: { addEventListener() { installed++; } },
    schedule() { installed++; }, subscribe() { installed++; },
  });
  try {
    monitor.setSource([{ key: "task" }]); await monitor.refresh();
    eventTarget.dispatchEvent(new Event("focus")); documentTarget.dispatchEvent(new Event("visibilitychange"));
    await turn(); assert.equal(installed, 0); assert.equal(reads, 1);
  } finally { monitor.dispose(); }
});

test("slow manual scans never overlap; repeated requests coalesce and checks stay bounded", async () => {
  const gate = deferred(); let running = 0, maximum = 0, reads = 0;
  const f = fixture(async () => { reads++; running++; maximum = Math.max(maximum, running); await gate.promise; running--; return status(); }, 3);
  try {
    f.monitor.setSource(Array.from({ length: 10 }, (_, key) => ({ key })));
    const first = f.monitor.refresh();
    f.monitor.refresh(); f.monitor.refresh();
    assert.equal(reads, 3); assert.equal(maximum, 3);
    gate.resolve(); await first;
    assert.equal(maximum, 3); assert.equal(running, 0); assert.equal(reads, 20);
    assert.equal(f.published.length, 1); assert.equal(f.published[0].size, 10);
    assert.deepEqual(f.busy, [true, false]);
  } finally { f.monitor.dispose(); }
});

test("changing project invalidates pending results and explicit refresh checks the new source", async () => {
  const gate = deferred(); let oldSignal;
  const f = fixture(async (entry, { signal }) => {
    if (entry.key === "old") { oldSignal = signal; await gate.promise; return status(true); }
    return status();
  });
  try {
    f.monitor.setSource([{ key: "old" }]); f.monitor.refresh();
    f.monitor.setSource([{ key: "new" }]);
    assert.equal(oldSignal.aborted, true); assert.equal(f.published.length, 0);
    const completion = f.monitor.refresh(); gate.resolve(); await completion;
    assert.deepEqual([...f.published.at(-1).keys()], ["new"]);
    assert.ok(f.published.every(map => !map.has("old")));
  } finally { f.monitor.dispose(); }
});

test("launcher enabled flags preserve status and never cause a rescan", async () => {
  let reads = 0;
  const root = {}, f = fixture(async () => { reads++; return status(true); });
  try {
    const row = { key: "p/t", root, path: "p/t", enabled: true };
    f.monitor.setSource([row]); await f.monitor.refresh();
    assert.equal(f.monitor.setSource([{ ...row, enabled: false }]), false);
    await turn(); assert.equal(reads, 1); assert.equal(f.published.length, 1);
    assert.equal(f.published.at(-1).get("p/t").hasSolution, true);
    await f.monitor.refresh(); assert.equal(reads, 2);
    // Identical relative paths in another root must discard the old status.
    f.monitor.setSource([{ ...row, root: {} }]);
    assert.equal(f.published.at(-1).size, 0);
  } finally { f.monitor.dispose(); }
});

test("list replacement retains unchanged rows until refresh and removes missing rows", async () => {
  let reads = 0;
  const first = { key: "first", handle: {} }, second = { key: "second", handle: {} };
  const f = fixture(async () => { reads++; return status(true); });
  try {
    f.monitor.setSource([first]); await f.monitor.refresh();
    f.monitor.setSource([first, second]); await turn();
    assert.equal(reads, 1); assert.equal(f.published.at(-1).get("first").hasSolution, true);
    assert.equal(f.published.at(-1).has("second"), false);
    await f.monitor.refresh(); assert.equal(f.published.at(-1).size, 2);
    f.monitor.setSource([second]); assert.deepEqual([...f.published.at(-1).keys()], ["second"]);
    f.monitor.setSource([]); await f.monitor.refresh(); assert.equal(f.published.at(-1).size, 0);
    assert.equal(reads, 3);
  } finally { f.monitor.dispose(); }
});

test("permission failure clears known state and recovered permission restores it on refresh", async () => {
  let denied = false;
  const f = fixture(async () => { if (denied) throw new Error("Access denied"); return status(true); });
  try {
    f.monitor.setSource([{ key: "task" }]); await f.monitor.refresh();
    denied = true; await f.monitor.refresh();
    assert.equal(f.published.at(-1).get("task").missingInput, null);
    assert.equal(f.published.at(-1).get("task").hasSolution, null);
    assert.equal(f.published.at(-1).get("task").errors.missingInput, "Access denied");
    denied = false; await f.monitor.refresh();
    assert.equal(f.published.at(-1).get("task").hasSolution, true);
  } finally { f.monitor.dispose(); }
});

test("dispose aborts pending checks and prevents late publication", async () => {
  const gate = deferred(); let signal, reads = 0;
  const f = fixture(async (_, options) => { signal = options.signal; reads++; await gate.promise; return status(true); });
  f.monitor.setSource([{ key: "task" }]); f.monitor.refresh(); f.monitor.dispose();
  assert.equal(signal.aborted, true); assert.deepEqual(f.busy, [true, false]);
  gate.resolve(); await f.monitor.refresh(); await turn();
  assert.equal(reads, 1); assert.equal(f.published.length, 0);
  assert.deepEqual(f.busy, [true, false]);
});


test("OM-only changes publish even when the solution flag is unchanged", async () => {
  let value = { ...status(true), omState: "none" };
  const f = fixture(async () => value);
  try {
    f.monitor.setSource([{ key: "task" }]); await f.monitor.refresh();
    for (const omState of ["active", "disabled", "none"]) {
      value = { ...value, omState }; await f.monitor.refresh();
      assert.equal(f.published.at(-1).get("task").omState, omState);
      assert.equal(f.published.at(-1).get("task").hasSolution, true);
    }
    assert.equal(f.published.length, 4);
  } finally { f.monitor.dispose(); }
});


test("marker-only changes are published on refresh without changing the solution checkmark", async () => {
  let value = status(true);
  const f = fixture(async () => value);
  try {
    f.monitor.setSource([{ key: "task" }]); await f.monitor.refresh();
    for (const planar2D of [true, false]) {
      value = { ...value, planar2D }; await f.monitor.refresh();
      assert.equal(f.published.at(-1).get("task").planar2D, planar2D);
      assert.equal(f.published.at(-1).get("task").hasSolution, true);
    }
    assert.equal(f.published.length, 3);
  } finally { f.monitor.dispose(); }
});
