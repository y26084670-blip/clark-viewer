import assert from "node:assert/strict";
import test from "node:test";
import { createTaskGifGalleryController } from "../src/services/taskGifGalleryController.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = name => ({ name, handle: { name } });
function fixture(options = {}) {
  let state;
  const states = [], created = [], revoked = [];
  const controller = createTaskGifGalleryController({
    list: async () => [file("a.gif"), file("b.gif"), file("c.gif")],
    read: async handle => new Blob([handle.name]),
    remove: async () => {},
    ...options,
    publish: next => { state = next; states.push(next); },
    createURL: blob => { const url = `blob:test-${created.length + 1}`; created.push({ url, blob }); return url; },
    revokeURL: url => revoked.push(url),
  });
  return { controller, states, created, revoked, get state() { return state; } };
}

test("inactive gallery performs no reads, and deactivation releases visible images", async () => {
  let lists = 0, reads = 0;
  const ui = fixture({ list: async () => { lists++; return [file("a.gif")]; },
    read: async () => { reads++; return new Blob(["GIF"]); } });
  const task = { name: "Task" };
  ui.controller.setContext(task, false); ui.controller.refresh(); await tick();
  assert.equal(lists, 0); assert.equal(reads, 0);
  ui.controller.setContext(task, true); await tick();
  assert.equal(lists, 1); assert.equal(reads, 0);
  ui.controller.setVisible(ui.state.entries[0], true); await tick();
  assert.equal(reads, 1); assert.equal(ui.created.length, 1);
  ui.controller.setContext(task, false);
  assert.equal(ui.state.entries.length, 0); assert.deepEqual(ui.revoked, ["blob:test-1"]);
  ui.controller.refresh(); await tick(); assert.equal(lists, 1);
  ui.controller.dispose();
});

test("thumbnail queue starts only visible files and never exceeds two unsettled reads", async () => {
  const pending = [], signals = []; let active = 0, maximum = 0;
  const ui = fixture({ read: (handle, { signal }) => {
    active++; maximum = Math.max(maximum, active); signals.push(signal);
    const job = deferred(); pending.push({ ...job, handle });
    return job.promise.finally(() => { active--; });
  } });
  ui.controller.setContext({}); await tick();
  const entries = ui.state.entries;
  entries.forEach(entry => ui.controller.setVisible(entry, true)); await tick();
  assert.equal(pending.length, 2); assert.equal(maximum, 2);
  ui.controller.setVisible(entries[0], false);
  assert.equal(signals[0].aborted, true);
  assert.equal(pending.length, 2, "an aborted browser read retains its slot until settled");
  pending[0].resolve(new Blob(["late"])); await tick();
  assert.equal(ui.created.length, 0); assert.equal(pending.length, 3);
  pending[1].resolve(new Blob(["b"])); pending[2].resolve(new Blob(["c"])); await tick();
  assert.equal(maximum, 2); assert.equal(active, 0); assert.equal(ui.created.length, 2);
  assert.equal(ui.state.entries, entries, "thumbnail publications preserve row identity");
  assert.equal(ui.state.thumbnails[entries[0].name].url, "");
  ui.controller.setVisible(entries[1], false);
  assert.deepEqual(ui.revoked, ["blob:test-1"]);
  ui.controller.dispose(); assert.deepEqual(ui.revoked, ["blob:test-1", "blob:test-2"]);
});

test("stale list scans are ignored and repeated refreshes coalesce into one next scan", async () => {
  const scans = []; let active = 0, maximum = 0;
  const ui = fixture({ list: (task, { signal }) => {
    active++; maximum = Math.max(maximum, active);
    const job = deferred(); scans.push({ ...job, task, signal });
    return job.promise.finally(() => active--);
  } });
  const first = { name: "First" }, latest = { name: "Latest" };
  ui.controller.setContext(first); await tick();
  ui.controller.refresh(); ui.controller.refresh(); ui.controller.setContext(latest); ui.controller.refresh();
  assert.equal(scans.length, 1); assert.equal(scans[0].signal.aborted, true);
  scans[0].resolve([file("stale.gif")]); await tick();
  assert.equal(scans.length, 2); assert.equal(scans[1].task, latest); assert.equal(maximum, 1);
  assert.equal(ui.state.entries.length, 0);
  scans[1].resolve([file("current.gif")]); await tick();
  assert.deepEqual(ui.state.entries.map(entry => entry.name), ["current.gif"]);
  assert.ok(ui.states.every(state => !state.entries.some(entry => entry.name === "stale.gif")));
  ui.controller.dispose();
});

test("task changes ignore late file results and errors without allocating stale URLs", async () => {
  const jobs = [];
  const ui = fixture({ read: (handle, { signal }) => { const job = deferred(); jobs.push({ ...job, signal }); return job.promise; } });
  ui.controller.setContext({ name: "Old" }); await tick();
  const old = ui.state.entries[0];
  ui.controller.setVisible(old, true); ui.controller.openPreview(old); await tick();
  assert.equal(jobs.length, 2);
  ui.controller.setContext({ name: "New" }); await tick();
  assert.equal(ui.state.preview, null); assert.equal(jobs[0].signal.aborted, true); assert.equal(jobs[1].signal.aborted, true);
  jobs[0].resolve(new Blob(["late"])); jobs[1].reject(new Error("stale error")); await tick();
  assert.equal(ui.created.length, 0); assert.equal(ui.state.error, "");
  assert.ok(Object.values(ui.state.thumbnails).every(thumb => !thumb.error));
  ui.controller.dispose();
});

test("preview owns an independent URL across scrolling and refresh; all URLs are eventually revoked once", async () => {
  const ui = fixture(); ui.controller.setContext({}); await tick();
  const entry = ui.state.entries[0];
  ui.controller.setVisible(entry, true); await tick();
  ui.controller.openPreview(entry); await tick();
  const previewURL = ui.state.preview.url;
  assert.equal(previewURL, "blob:test-2");
  ui.controller.setVisible(entry, false);
  assert.deepEqual(ui.revoked, ["blob:test-1"]); assert.equal(ui.state.preview.url, previewURL);
  ui.controller.refresh(); await tick();
  assert.equal(ui.state.preview.url, previewURL);
  assert.notEqual(ui.state.entries[0], entry, "refresh creates new cells for external file changes");
  ui.controller.setVisible(ui.state.entries[0], true); await tick();
  ui.controller.closePreview(); assert.deepEqual(ui.revoked, ["blob:test-1", "blob:test-2"]);
  ui.controller.dispose(); assert.deepEqual(ui.revoked, ui.created.map(item => item.url));
});

test("deletion invokes its service synchronously, releases deleted resources, and refreshes", async () => {
  let files = [file("a.gif"), file("b.gif")], calls = 0, deleteSignal;
  const job = deferred();
  const ui = fixture({ list: async () => files, remove: (_task, entry, { signal }) => {
    calls++; deleteSignal = signal; return job.promise.then(() => { files = files.filter(item => item.name !== entry.name); });
  } });
  ui.controller.setContext({}); await tick(); const entry = ui.state.entries[0];
  ui.controller.setVisible(entry, true); ui.controller.openPreview(entry); await tick();
  const operation = ui.controller.deleteEntry(entry);
  assert.equal(calls, 1, "write permission must start inside the explicit click, before await");
  assert.equal(ui.state.deleting, "a.gif"); assert.equal(deleteSignal.aborted, false);
  assert.equal(await ui.controller.deleteEntry(entry), false, "a duplicate click cannot start another deletion");
  job.resolve(); assert.equal(await operation, true); await tick();
  assert.deepEqual(ui.state.entries.map(item => item.name), ["b.gif"]);
  assert.equal(ui.state.preview, null); assert.equal(ui.state.deleting, null);
  assert.equal(ui.revoked.length, 2); ui.controller.dispose();
});

test("deletion errors are shown only for the same active task", async () => {
  const jobs = [];
  const ui = fixture({ remove: () => { const job = deferred(); jobs.push(job); return job.promise; } });
  ui.controller.setContext({}); await tick();
  const first = ui.controller.deleteEntry(ui.state.entries[0]);
  jobs[0].reject(new Error("Permission denied")); assert.equal(await first, false);
  assert.equal(ui.state.error, "Permission denied"); assert.equal(ui.state.deleting, null);
  const second = ui.controller.deleteEntry(ui.state.entries[0]);
  ui.controller.setContext({}); await tick();
  jobs[1].reject(new Error("Old task error")); assert.equal(await second, false);
  assert.equal(ui.state.error, ""); assert.equal(ui.state.deleting, null); ui.controller.dispose();
});

test("image decode failures release only their matching current URL", async () => {
  const ui = fixture(); ui.controller.setContext({}); await tick(); const entry = ui.state.entries[0];
  ui.controller.setVisible(entry, true); ui.controller.openPreview(entry); await tick();
  const thumbnailURL = ui.state.thumbnails[entry.name].url, previewURL = ui.state.preview.url;
  ui.controller.thumbnailFailed(entry, "blob:old"); ui.controller.previewFailed("blob:old");
  assert.equal(ui.revoked.length, 0);
  ui.controller.thumbnailFailed(entry, thumbnailURL);
  assert.match(ui.state.thumbnails[entry.name].error, /отобразить/);
  assert.equal(ui.state.preview.url, previewURL);
  ui.controller.previewFailed(previewURL);
  assert.match(ui.state.preview.error, /отобразить/); assert.equal(ui.revoked.length, 2);
  ui.controller.dispose(); assert.equal(ui.revoked.length, 2);
});

// Execute the actual gallery event/lifecycle setup without JSX. The thumbnail
// subcomponent's JSX is excluded; its watchCell callback is exercised directly.
const { readFileSync } = await import("node:fs");
const source = readFileSync(new URL("../src/components/tasks/TaskGifGallery.jsx", import.meta.url), "utf8");
const childStart = source.indexOf("  function GifCell(");
const effectsStart = source.indexOf("  createEffect(", childStart);
const setup = (source.slice(source.indexOf("export function TaskGifGallery"), childStart)
  + source.slice(effectsStart, source.indexOf('  return <section class="task-gif-gallery"'))).replace("export function", "function");
const makeGallery = new Function("props", "createSignal", "createUniqueId", "createTaskGifGalleryController", "createEffect", "onMount", "onCleanup", "subscribeTaskGifs", "queueMicrotask", "window", "IntersectionObserver", `
  ${setup}
    return { requestDelete, confirmDelete, showPreview, watchCell, updateFallbackVisibility,
      startDrag, moveDrag, stopDrag, clampPreview, view, setView, deleteRequest,
      position: dialogPosition, maximized, toggleMaximized, dialogSize,
      attach(refs) { grid=refs.grid; dialog=refs.dialog; dialogHeader=refs.dialogHeader; closeButton=refs.closeButton;
        confirmDialog=refs.confirmDialog; confirmCancelButton=refs.confirmCancelButton; } };
  } return TaskGifGallery(props);
`);
function componentRuntime({ withObserver = true, deleteOperation = async () => true } = {}) {
  const effects = [], mounts = [], cleanup = [], queued = [], busy = [], calls = [], observers = [];
  const listeners = new Map(), subscribers = new Set();
  const window = { innerWidth: 500, innerHeight: 400,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); } };
  const dialog = () => ({ open: false, showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 50, top: 60, width: 300, height: 200 }) });
  const focus = () => ({ focused: 0, isConnected: true, focus() { this.focused++; } });
  const capture = new Set();
  const refs = { grid: { getBoundingClientRect: () => ({ left: 0, right: 200, top: 100, bottom: 300 }) },
    dialog: dialog(), confirmDialog: dialog(), closeButton: focus(), confirmCancelButton: focus(),
    dialogHeader: { setPointerCapture: id => capture.add(id), hasPointerCapture: id => capture.has(id), releasePointerCapture: id => capture.delete(id) }, opener: focus() };
  const Observer = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.targets.clear(); }
  };
  const props = { taskHandle: { name: "Task" }, active: true, disabled: false, refreshKey: 0,
    onBusyChange(value) { busy.push(value); props.disabled = value; } };
  const controller = {
    setContext: (...args) => calls.push(["context", ...args]), refresh: () => calls.push(["refresh"]),
    setVisible: (...args) => calls.push(["visible", ...args]), openPreview: entry => calls.push(["open", entry]),
    closePreview: () => calls.push(["close"]),
    deleteEntry(entry) { calls.push(["delete", entry, [...busy]]); return deleteOperation(entry); },
    dispose: () => calls.push(["dispose"]),
  };
  const ui = makeGallery(props, initial => { let value = initial; return [() => value, next => { value = next; }]; },
    () => "gif-title", () => controller, callback => effects.push(callback), callback => mounts.push(callback),
    callback => cleanup.push(callback), callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
    callback => queued.push(callback), window, withObserver ? Observer : undefined);
  ui.attach(refs);
  const entry = file("exact.gif");
  ui.setView({ entries: [entry], thumbnails: {}, loading: false, error: "", deleting: null, preview: null });
  return { ...ui, props, refs, entry, calls, busy, observers, capture, listeners, subscribers,
    flushEffects() { effects.forEach(callback => callback()); },
    mount() { mounts.forEach(callback => callback()); queued.splice(0).forEach(callback => callback()); },
    dispose() { cleanup.splice(0).forEach(callback => callback()); },
  };
}

test("Delete confirmation requires a new explicit click and raises busy before the synchronous service call", async () => {
  const job = deferred(), ui = componentRuntime({ deleteOperation: () => job.promise });
  ui.requestDelete(ui.entry, { currentTarget: ui.refs.opener }); ui.flushEffects();
  assert.equal(ui.refs.confirmDialog.open, true); assert.equal(ui.deleteRequest().entry, ui.entry);
  assert.equal(ui.calls.filter(call => call[0] === "delete").length, 0);
  assert.deepEqual(ui.busy, []);
  const operation = ui.confirmDelete();
  const deletion = ui.calls.find(call => call[0] === "delete");
  assert.equal(deletion[1], ui.entry); assert.deepEqual(deletion[2], [true]);
  assert.equal(ui.deleteRequest(), null);
  job.resolve(true); await operation; assert.deepEqual(ui.busy, [true, false]); ui.dispose();
});

test("pending Delete confirmation is discarded on task, active, disabled or refreshed-entry changes", async () => {
  for (const change of [
    ui => { ui.props.taskHandle = { name: "Other" }; },
    ui => { ui.props.active = false; },
    ui => { ui.props.disabled = true; },
    ui => { ui.setView({ ...ui.view(), entries: [file("exact.gif")] }); },
  ]) {
    const ui = componentRuntime(); ui.requestDelete(ui.entry, { currentTarget: ui.refs.opener }); ui.flushEffects();
    assert.equal(ui.refs.confirmDialog.open, true);
    change(ui); ui.flushEffects(); await ui.confirmDelete();
    assert.equal(ui.deleteRequest(), null); assert.equal(ui.refs.confirmDialog.open, false);
    assert.equal(ui.calls.filter(call => call[0] === "delete").length, 0); assert.deepEqual(ui.busy, []); ui.dispose();
  }
});

test("confirmed deletion releases parent busy on cleanup and does not release it twice after a late completion", async () => {
  const job = deferred(), ui = componentRuntime({ deleteOperation: () => job.promise });
  ui.requestDelete(ui.entry, { currentTarget: ui.refs.opener });
  const operation = ui.confirmDelete(); assert.deepEqual(ui.busy, [true]);
  ui.dispose(); assert.deepEqual(ui.busy, [true, false]);
  job.resolve(true); await operation; assert.deepEqual(ui.busy, [true, false]);
});

test("gallery observes only intersecting cells and refreshes through active context, focus and file-change events", () => {
  const ui = componentRuntime(); const cell = {};
  const unwatch = ui.watchCell(cell, ui.entry); ui.mount(); ui.flushEffects();
  const observer = ui.observers[0]; assert.equal(observer.options.root, ui.refs.grid);
  assert.equal(observer.targets.has(cell), true);
  observer.callback([{ target: cell, isIntersecting: true, intersectionRatio: .1 }]);
  observer.callback([{ target: cell, isIntersecting: false, intersectionRatio: 0 }]);
  assert.deepEqual(ui.calls.filter(call => call[0] === "visible").map(call => call[2]), [true, false]);
  ui.listeners.get("focus")(); [...ui.subscribers][0]();
  ui.props.refreshKey++; ui.flushEffects();
  assert.equal(ui.calls.filter(call => call[0] === "refresh").length, 3);
  ui.props.active = false; ui.flushEffects();
  assert.equal(ui.calls.filter(call => call[0] === "context").at(-1)[2], false);
  unwatch(); assert.equal(observer.targets.has(cell), false);
  ui.dispose(); assert.equal(ui.subscribers.size, 0); assert.equal(ui.listeners.size, 0);
});

test("fallback checks visible cell rectangles and preview dragging stays inside the viewport", () => {
  const ui = componentRuntime({ withObserver: false });
  const visible = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 120, bottom: 260 }) };
  const hidden = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 500, bottom: 640 }) };
  ui.watchCell(visible, ui.entry); ui.watchCell(hidden, file("hidden.gif")); ui.mount();
  const visibility = ui.calls.filter(call => call[0] === "visible");
  assert.ok(visibility.some(call => call[1] === ui.entry && call[2] === true));
  assert.ok(visibility.some(call => call[1].name === "hidden.gif" && call[2] === false));
  const event = { button: 0, pointerId: 1, clientX: 60, clientY: 70, target: { closest: () => null }, preventDefault() {} };
  ui.startDrag(event); ui.moveDrag({ ...event, clientX: 2000, clientY: 2000 });
  assert.deepEqual(ui.position(), { left: 200, top: 200 });
  ui.moveDrag({ ...event, clientX: -2000, clientY: -2000 });
  assert.deepEqual(ui.position(), { left: 0, top: 0 });
  assert.equal(ui.capture.has(1), true); ui.stopDrag(); assert.equal(ui.capture.has(1), false); ui.dispose();
});


test("preview maximize restores its measured size and blocks dragging only while maximized",()=>{
  const ui=componentRuntime();ui.showPreview(ui.entry,{currentTarget:ui.refs.opener});
  ui.toggleMaximized();assert.equal(ui.maximized(),true);
  ui.startDrag({button:0,pointerId:1,target:{closest:()=>null},preventDefault(){}});
  assert.equal(ui.capture.size,0);
  ui.toggleMaximized();assert.equal(ui.maximized(),false);
  assert.deepEqual(ui.dialogSize(),{width:300,height:200});assert.deepEqual(ui.position(),{left:50,top:60});
  ui.toggleMaximized();ui.showPreview(ui.entry,{currentTarget:ui.refs.opener});assert.equal(ui.maximized(),false);ui.dispose();
});
