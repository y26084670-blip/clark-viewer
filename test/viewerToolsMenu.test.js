import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/movie/ViewerToolsMenu.jsx", import.meta.url), "utf8");
const setup = source.slice(source.indexOf("export function ViewerToolsMenu"), source.indexOf("  return <>"))
  .replace("export function", "function");
const createRuntime = new Function("props", "createSignal", "createUniqueId", "createEffect", "onCleanup", "queueMicrotask", "window", "document", "URL", "saveTaskGif", `
  ${setup}
    return { toggleMenu, closeMenu, openSetup, closeDialog, startCapture, cancelCapture,
      onTriggerKeyDown, onMenuKeyDown, progressText, setIntervalMs, validInterval, saveToTask, changeSaveLocation,
      state: () => ({ menuOpen: menuOpen(), menuPosition: menuPosition(), dialogOpen: dialogOpen(),
        phase: phase(), result: result(), progress: progress(), error: error(),
        saveInTask: saveInTask(), saving: saving(), savedNotice: savedNotice() }),
      attach(refs) { trigger=refs.trigger; menu=refs.menu; menuItem=refs.menuItem; dialog=refs.dialog;
        intervalInput=refs.intervalInput; cancelButton=refs.cancelButton; saveButton=refs.saveButton; } };
  }
  return ViewerToolsMenu(props);
`);
function events() {
  const callbacks = new Map();
  return { addEventListener(name, fn) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(fn); },
    removeEventListener(name, fn) { callbacks.get(name)?.delete(fn); },
    emit(name, event = {}) { for (const fn of [...callbacks.get(name) ?? []]) fn(event); },
    count(name) { return callbacks.get(name)?.size ?? 0; } };
}
function runtime(overrides = {}) {
  const cleanups = [], effects = [], urls = [], revoked = [], busy = [];
  let currentEffect;
  const document = events(), window = { ...events(), innerWidth: 900, innerHeight: 600 };
  const focusable = () => ({ focused: 0, focus() { this.focused++; } });
  const refs = { trigger: { ...focusable(), ownerDocument: document,
    getBoundingClientRect: () => ({ right: 890, bottom: 590 }) },
    menu: { offsetWidth: 260, offsetHeight: 90 }, menuItem: focusable(),
    dialog: { open: false, showModal() { this.open = true; }, close() { this.open = false; } },
    intervalInput: focusable(), cancelButton: focusable(), saveButton: focusable() };
  const props = { eligible: true, task: {}, tabIndex: 1, frameCount: 3,
    onBusyChange(value) { busy.push(value); }, ...overrides };
  let nextId = 0;
  const api = createRuntime(props, initial => {
    let value = initial;
    return [() => value, next => { value = typeof next === "function" ? next(value) : next; }];
  }, () => `menu-${++nextId}`, callback => effects.push({ callback, cleanups: [] }),
  callback => (currentEffect?.cleanups ?? cleanups).push(callback), callback => callback(), window, document,
  { createObjectURL(blob) { const url = `blob:test/${urls.length + 1}`; urls.push({ url, blob }); return url; },
    revokeObjectURL(url) { revoked.push(url); } }, overrides.saveTaskGif ?? (async () => ({ name: "example.gif" })));
  api.attach(refs);
  return { ...api, props, refs, window, document, busy, urls, revoked,
    flushEffects() { for (const effect of effects) {
      effect.cleanups.splice(0).forEach(fn => fn()); currentEffect = effect;
      effect.callback(); currentEffect = undefined;
    } },
    dispose() { effects.forEach(effect => effect.cleanups.splice(0).forEach(fn => fn())); cleanups.splice(0).forEach(fn => fn()); },
  };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const gif = () => ({ blob: new Blob(["GIF89a"], { type: "image/gif" }), filename: "example.gif", frameCount: 3, width: 100, height: 80 });
const key = code => ({ code, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });

test("menu is keyboard accessible, closes outside and stays within the viewport", () => {
  const ui = runtime();
  const down = key("ArrowDown"); ui.onTriggerKeyDown(down); ui.flushEffects();
  assert.equal(down.prevented, true); assert.equal(ui.state().menuOpen, true);
  assert.equal(ui.refs.menuItem.focused, 1);
  assert.deepEqual(ui.state().menuPosition, { left: 630, top: 502 });
  assert.equal(ui.document.count("pointerdown"), 1);
  ui.document.emit("pointerdown", { composedPath: () => [ui.refs.menuItem, ui.refs.menu] });
  assert.equal(ui.state().menuOpen, true);
  for (const code of ["Home", "End", "ArrowUp", "ArrowDown"]) {
    const event = key(code); ui.onMenuKeyDown(event); assert.equal(event.prevented, true);
  }
  ui.document.emit("pointerdown", { composedPath: () => [{}] }); ui.flushEffects();
  assert.equal(ui.state().menuOpen, false); assert.equal(ui.document.count("pointerdown"), 0);
  ui.toggleMenu(); ui.flushEffects(); ui.document.emit("keydown", key("Escape")); ui.flushEffects();
  assert.equal(ui.state().menuOpen, false); assert.ok(ui.refs.trigger.focused > 0);
  ui.toggleMenu(); ui.flushEffects(); ui.window.emit("scroll"); ui.flushEffects();
  assert.equal(ui.state().menuOpen, false);
  ui.dispose();
});

test("unavailable item and invalid frame intervals never start capture", async () => {
  let starts = 0;
  const ui = runtime({ eligible: false, onRun: async () => { starts++; return gif(); } });
  ui.openSetup(); assert.equal(ui.state().dialogOpen, false);
  await ui.startCapture(); assert.equal(starts, 0);
  ui.props.eligible = true; ui.openSetup(); ui.flushEffects();
  assert.equal(ui.refs.dialog.open, true);
  for (const interval of [NaN, 0, 19, 25, 60001]) {
    ui.setIntervalMs(interval); await ui.startCapture();
    assert.equal(starts, 0); assert.match(ui.state().error, /20 до 60000/);
  }
  ui.dispose();
});

test("capture locks controls, reports progress, offers a GIF only after completion and revokes its URL", async () => {
  const job = deferred(); let request;
  const ui = runtime({ onRun: options => { request = options; return job.promise; } });
  ui.openSetup(); const run = ui.startCapture();
  assert.deepEqual(ui.busy, [true]); assert.equal(ui.state().phase, "running");
  assert.equal(request.intervalMs, 100); assert.equal(request.signal.aborted, false);
  request.onProgress({ phase: "capturing", completed: 2, total: 3, step: 1 });
  assert.equal(ui.progressText(), "Кадр 2 из 3");
  assert.equal(ui.state().result, null);
  job.resolve(gif()); await run;
  assert.deepEqual(ui.busy, [true, false]); assert.equal(ui.state().phase, "ready");
  assert.equal(ui.state().result.filename, "example.gif");
  assert.equal(ui.urls.length, 1); assert.equal(ui.refs.saveButton.focused, 1);
  ui.closeDialog(); ui.flushEffects();
  assert.deepEqual(ui.revoked, ["blob:test/1"]); assert.equal(ui.state().result, null);
  ui.dispose();
});

test("cancel waits for restoration and rejects a late successful GIF", async () => {
  const job = deferred(); let request;
  const ui = runtime({ onRun: options => { request = options; return job.promise; } });
  ui.openSetup(); const run = ui.startCapture(); ui.cancelCapture(false);
  assert.equal(request.signal.aborted, true); assert.equal(ui.state().phase, "cancelling");
  assert.deepEqual(ui.busy, [true]);
  job.resolve(gif()); await run;
  assert.deepEqual(ui.busy, [true, false]); assert.equal(ui.state().phase, "setup");
  assert.equal(ui.state().dialogOpen, true); assert.equal(ui.urls.length, 0);
  ui.dispose();
});

test("task/tab change cancels an export and closes the dialog after restoration", async () => {
  for (const changed of ["task", "tabIndex"]) {
    const job = deferred(); let request;
    const ui = runtime({ onRun: options => { request = options; return job.promise; } });
    ui.openSetup(); ui.flushEffects(); const run = ui.startCapture();
    ui.props[changed] = changed === "task" ? {} : 2; ui.flushEffects();
    assert.equal(request.signal.aborted, true); assert.equal(ui.state().dialogOpen, true);
    job.reject(new DOMException("Cancelled", "AbortError")); await run; ui.flushEffects();
    assert.equal(ui.state().dialogOpen, false); assert.equal(ui.refs.dialog.open, false);
    assert.deepEqual(ui.busy, [true, false]); ui.dispose();
  }
});

test("a restoration failure stays visible even when capture was cancelled or its dialog was closing", async () => {
  for (const cancel of [ui => ui.cancelCapture(false), ui => ui.closeDialog(), ui => {
    ui.props.task = {}; ui.flushEffects();
  }]) {
    const job = deferred(); let request;
    const ui = runtime({ onRun: options => { request = options; return job.promise; } });
    ui.openSetup(); ui.flushEffects(); const run = ui.startCapture(); cancel(ui);
    assert.equal(request.signal.aborted, true);
    job.reject(new Error("Не удалось восстановить исходный вид")); await run; ui.flushEffects();
    assert.equal(ui.state().phase, "error");
    assert.match(ui.state().error, /восстановить/);
    assert.equal(ui.state().dialogOpen, true);
    assert.equal(ui.refs.dialog.open, true);
    assert.deepEqual(ui.busy, [true, false]);
    assert.equal(ui.urls.length, 0); ui.dispose();
  }
});

test("encoder errors remain retryable and disposal aborts without publishing a late result", async () => {
  const ui = runtime({ onRun: async () => { throw new Error("GIF failed"); } });
  ui.openSetup(); await ui.startCapture();
  assert.equal(ui.state().phase, "error"); assert.equal(ui.state().error, "GIF failed");
  assert.deepEqual(ui.busy, [true, false]);
  ui.props.onRun = async () => gif(); await ui.startCapture();
  assert.equal(ui.state().phase, "ready"); ui.dispose(); assert.deepEqual(ui.revoked, ["blob:test/1"]);
  const job = deferred(); let request;
  const second = runtime({ onRun: options => { request = options; return job.promise; } });
  second.openSetup(); const run = second.startCapture(); second.dispose();
  assert.equal(request.signal.aborted, true);
  job.resolve(gif()); await run;
  assert.equal(second.urls.length, 0); assert.deepEqual(second.busy, [true, false]);
});

test("save-in-task defaults off and writes only on a click using the captured loaded task", async () => {
  const write = deferred(), saved = [];
  const task = { handle: { name: "loaded-task" } };
  const ui = runtime({ task, onRun: async () => gif(), saveTaskGif: (...args) => { saved.push(args); return write.promise; } });
  ui.openSetup(); await ui.startCapture();
  assert.equal(ui.state().saveInTask, false);
  assert.equal(ui.state().result.task, task);
  await ui.saveToTask(); assert.equal(saved.length, 0);
  ui.changeSaveLocation(true); assert.equal(saved.length, 0, "checking a destination never creates files");
  const save = ui.saveToTask();
  assert.equal(saved.length, 1, "service is invoked synchronously before the click handler awaits");
  assert.equal(saved[0][0], task.handle);
  assert.equal(saved[0][1], ui.state().result.blob);
  assert.equal(saved[0][2], "example.gif");
  assert.equal(saved[0][3].signal.aborted, false);
  assert.equal(ui.state().saving, true);
  assert.deepEqual(ui.busy, [true, false, true]);
  ui.closeDialog(); ui.changeSaveLocation(false); ui.openSetup();
  assert.equal(ui.state().dialogOpen, true, "Close and Escape cannot discard a pending save");
  assert.equal(ui.state().saveInTask, true);
  assert.equal(ui.revoked.length, 0);
  await ui.saveToTask(); assert.equal(saved.length, 1, "duplicate save clicks are ignored");
  write.resolve({ name: "example_2.gif" }); await save;
  assert.equal(ui.state().saving, false);
  assert.equal(ui.state().savedNotice, "Сохранено: output3XX/demo/example_2.gif");
  assert.equal(ui.state().phase, "ready");
  assert.deepEqual(ui.busy, [true, false, true, false]);
  assert.equal(ui.urls.length, 1); assert.equal(ui.revoked.length, 0);
  ui.closeDialog(); ui.openSetup();
  assert.equal(ui.state().saveInTask, false, "each new movie starts with normal download destination");
  ui.dispose();
});

test("denied write permission preserves GIF, enables retry and keeps normal download available", async () => {
  let attempts = 0;
  const ui = runtime({ task: { handle: {} }, onRun: async () => gif(), saveTaskGif: async () => {
    if (++attempts === 1) throw new DOMException("Нет разрешения на запись", "NotAllowedError");
    return { name: "example.gif" };
  } });
  ui.openSetup(); await ui.startCapture(); const movie = ui.state().result;
  ui.changeSaveLocation(true); await ui.saveToTask();
  assert.equal(ui.state().phase, "ready"); assert.equal(ui.state().result, movie);
  assert.equal(ui.state().saving, false); assert.match(ui.state().error, /разрешения/);
  assert.equal(ui.revoked.length, 0);
  ui.changeSaveLocation(false); await ui.saveToTask();
  assert.equal(attempts, 1); assert.equal(ui.state().result.url, movie.url);
  ui.changeSaveLocation(true); await ui.saveToTask();
  assert.equal(attempts, 2); assert.equal(ui.state().error, "");
  assert.match(ui.state().savedNotice, /example\.gif$/);
  ui.dispose();
});

test("task/tab changes cancel a pending save, release its URL and never publish into another task", async () => {
  for (const changed of ["task", "tabIndex"]) {
    const write = deferred(); let signal;
    const ui = runtime({ task: { handle: {} }, onRun: async () => gif(), saveTaskGif: (_handle, _blob, _name, options) => {
      signal = options.signal; return write.promise;
    } });
    ui.openSetup(); ui.flushEffects(); await ui.startCapture();
    ui.changeSaveLocation(true); const saving = ui.saveToTask();
    ui.props[changed] = changed === "task" ? { handle: {} } : 2; ui.flushEffects();
    assert.equal(signal.aborted, true);
    write.reject(new DOMException("Cancelled", "AbortError")); await saving; ui.flushEffects();
    assert.equal(ui.state().saving, false); assert.equal(ui.state().dialogOpen, false);
    assert.equal(ui.state().savedNotice, ""); assert.equal(ui.state().result, null);
    assert.deepEqual(ui.revoked, ["blob:test/1"]);
    assert.deepEqual(ui.busy, [true, false, true, false]); ui.dispose();
  }
});

test("stale result cannot write another loaded task and unmount aborts a save without leaking its GIF", async () => {
  let writes = 0;
  const stale = runtime({ task: { handle: {} }, onRun: async () => gif(), saveTaskGif: async () => { writes++; return { name: "wrong.gif" }; } });
  stale.openSetup(); await stale.startCapture(); stale.changeSaveLocation(true);
  stale.props.task = { handle: {} }; await stale.saveToTask();
  assert.equal(writes, 0); assert.match(stale.state().error, /Задание изменилось/);
  assert.ok(stale.state().result); stale.dispose();

  const write = deferred(); let signal;
  const ui = runtime({ task: { handle: {} }, onRun: async () => gif(), saveTaskGif: (_handle, _blob, _name, options) => {
    signal = options.signal; return write.promise;
  } });
  ui.openSetup(); await ui.startCapture(); ui.changeSaveLocation(true);
  const save = ui.saveToTask(); ui.dispose();
  assert.equal(signal.aborted, true); assert.deepEqual(ui.revoked, ["blob:test/1"]);
  write.resolve({ name: "late.gif" }); await save;
  assert.equal(ui.state().savedNotice, ""); assert.equal(ui.state().result, null);
  assert.deepEqual(ui.busy, [true, false, true, false]);
});

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const appSetup = appSource.slice(appSource.indexOf("export default function App"), appSource.indexOf('  return <div class="app-container"'))
  .replace("export default function", "function");
const createApp = new Function("createSignal", "onCleanup", "createMovieExportController", "createMovieGifEncoder", `
  ${appSetup}
    return { shared, movieDisabledReason, setTask, setActive, setBusy, setMovieBusy };
  } return App();
`);

test("App permits only ready dynamic result tabs and separates guarded UI time from movie time", () => {
  let controllerOptions, disposed = 0;
  const cleanup = [];
  const controller = { register() {}, dispose() { disposed++; } };
  const app = createApp(initial => {
    let value = initial;
    return [() => value, next => { value = typeof next === "function" ? next(value) : next; }];
  }, callback => cleanup.push(callback), options => { controllerOptions = options; return controller; }, () => {});
  assert.match(app.movieDisabledReason(), /Загрузите/);
  app.setTask({ general: { countTimeSteps: 4, timeStep: .1 } });
  assert.match(app.movieDisabledReason(), /вкладку/);
  app.setActive(1); assert.match(app.movieDisabledReason(), /готовности/);
  controllerOptions.onAdapterChange({}); assert.equal(app.movieDisabledReason(), "");
  for (const tab of [1, 2, 3, 4, 5, 6]) { app.setActive(tab); assert.equal(app.movieDisabledReason(), ""); }
  app.setBusy(true); assert.match(app.movieDisabledReason(), /загрузки/); app.setBusy(false);
  for (const timeStep of [0, -1, NaN, Infinity]) {
    app.setTask({ general: { countTimeSteps: 4, timeStep } });
    assert.match(app.movieDisabledReason(), /динамических/);
  }
  app.setTask({ general: { countTimeSteps: 0, timeStep: .1 } });
  assert.match(app.movieDisabledReason(), /динамических/);
  app.setTask({ general: { countTimeSteps: 4, timeStep: .1 } });
  app.shared.setTime(3); app.shared.setElements([1]); app.shared.setRegions([2]); app.shared.setCoils([3]);
  app.setMovieBusy(true);
  app.shared.setTime(0); app.shared.setElements([]); app.shared.setRegions([]); app.shared.setCoils([]);
  assert.equal(app.shared.time, 3);
  assert.deepEqual(app.shared.elements, [1]); assert.deepEqual(app.shared.regions, [2]); assert.deepEqual(app.shared.coils, [3]);
  app.shared.setMovieTime(100); assert.equal(app.shared.time, 4);
  app.shared.setMovieTime(-1); assert.equal(app.shared.time, 0);
  assert.equal(app.shared.registerMovieAdapter, controller.register);
  app.setMovieBusy(false); app.shared.setTime(2); assert.equal(app.shared.time, 2);
  cleanup.forEach(callback => callback()); assert.equal(disposed, 1);
});
