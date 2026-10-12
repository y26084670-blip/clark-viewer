import assert from "node:assert/strict";
import test from "node:test";
import { createLastOpenedTaskHistory, LAST_OPENED_TASK_FILES, sortTaskDirectories } from "../src/services/taskLastOpenedService.js";

const record = (projectIndex, taskIndex) => JSON.stringify({ version: 1, projectIndex, taskIndex }) + "\n";
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}
function directory(initial = {}, hooks = {}) {
  const files = new Map(Object.entries(initial)), writes = [], created = [];
  return {
    files, writes, created,
    async getFileHandle(name, options) {
      await hooks.lookup?.(name, options);
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("Missing", "NotFoundError");
        created.push(name); files.set(name, "");
      }
      return {
        async getFile() { return { text: async () => { await hooks.read?.(); return files.get(name); } }; },
        async createWritable() {
          await hooks.writable?.();
          let value;
          return {
            async write(text) { value = text; await hooks.write?.(text); },
            async close() { await hooks.close?.(); files.set(name, value); writes.push({ name, value }); },
            async abort() { await hooks.abort?.(); },
          };
        },
      };
    },
  };
}
function runtime(app = "editor") {
  const state = { positions: null, notice: "", changes: [] };
  const history = createLastOpenedTaskHistory({ app,
    onChange(value) { state.positions = value; state.changes.push(value); },
    onNotice(value) { state.notice = value; },
  });
  const projects = [{ name: "Project 2" }, { name: "Project 10" }];
  const tasks = [{ name: "Task 2", handle: {} }, { name: "Task 10", handle: {} }];
  return { state, history, projects, tasks, capture: () => history.capture(projects, "Project 10", tasks, tasks[1]) };
}

test("directories use the same natural Russian ordering without mutating their input", () => {
  const input = ["Задание 10", "Задание 2", "А", "Я"].map(name => ({ name }));
  assert.deepEqual(sortTaskDirectories(input).map(item => item.name), ["А", "Задание 2", "Задание 10", "Я"]);
  assert.equal(input[0].name, "Задание 10");
});

test("granting access initializes only the application's own JSON file", async () => {
  for (const app of ["editor", "viewer"]) {
    const root = directory(), h = runtime(app);
    await h.history.open(root);
    assert.deepEqual(root.created, [LAST_OPENED_TASK_FILES[app]]);
    assert.equal(root.files.get(LAST_OPENED_TASK_FILES[app]), record(null, null));
    assert.equal(h.state.positions, null); assert.equal(h.state.notice, "");
  }
});

test("opening a task replaces the previous positions with one-based ordinals and restores on a new session", async () => {
  const root = directory(), h = runtime();
  await h.history.open(root);
  assert.equal(await h.history.remember(h.capture()), true);
  assert.deepEqual(h.state.positions, { projectIndex: 2, taskIndex: 2 });
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(2, 2));
  await h.history.remember(h.history.capture(h.projects, "Project 2", h.tasks, h.tasks[0]));
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(1, 1));
  const reopened = runtime(); await reopened.history.open(root);
  assert.deepEqual(reopened.state.positions, { projectIndex: 1, taskIndex: 1 });
  assert.equal(root.writes.length, 3);
});

test("Editor and Viewer keep independent positions in the same root", async () => {
  const root = directory(), editor = runtime(), viewer = runtime("viewer");
  await Promise.all([editor.history.open(root), viewer.history.open(root)]);
  await editor.history.remember(editor.capture());
  await viewer.history.remember(viewer.history.capture(viewer.projects, "Project 2", viewer.tasks, viewer.tasks[0]));
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(2, 2));
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.viewer), record(1, 1));
});

test("reading saved positions does not rewrite them or invent a project/task selection", async () => {
  const root = directory({ [LAST_OPENED_TASK_FILES.editor]: record(200, 500) }), h = runtime();
  await h.history.open(root);
  assert.deepEqual(h.state.positions, { projectIndex: 200, taskIndex: 500 });
  assert.equal(h.projects[h.state.positions.projectIndex - 1], undefined);
  assert.deepEqual(root.writes, []);
});

test("bad JSON and invalid or unsupported records give no mark and are preserved until a successful task opens", async () => {
  for (const text of ["{", "null", record(0, 1), record(1, -2), record(1.5, 2), record("1", 2), record(null, 2), '{"version":2,"projectIndex":1,"taskIndex":1}', '{"version":1}']) {
    const root = directory({ [LAST_OPENED_TASK_FILES.editor]: text }), h = runtime();
    await h.history.open(root);
    assert.equal(h.state.positions, null); assert.match(h.state.notice, /прочитать/u);
    assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), text);
    await h.history.remember(h.capture());
    assert.equal(h.state.notice, ""); assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(2, 2));
  }
});

test("permission or disk errors leave the in-memory mark and report that it was not saved", async () => {
  const h = runtime(), root = directory({}, { writable() { throw new DOMException("Denied", "NotAllowedError"); } });
  await h.history.open(root);
  assert.match(h.state.notice, /сохранить/u);
  assert.equal(await h.history.remember(h.capture()), false);
  assert.deepEqual(h.state.positions, { projectIndex: 2, taskIndex: 2 });
  assert.match(h.state.notice, /Denied/u);
});

test("a write failure aborts the transaction and preserves the previous record", async () => {
  let aborts = 0;
  const root = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, {
    write() { throw new Error("Disk full"); }, abort() { aborts++; },
  }), h = runtime();
  await h.history.open(root); await h.history.remember(h.capture());
  assert.equal(aborts, 1); assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(1, 1));
  assert.match(h.state.notice, /Disk full/u);
});

test("preview capture, demos and tasks outside the current lists do not update the record", async () => {
  const root = directory(), h = runtime(); await h.history.open(root);
  h.capture(); assert.equal(root.writes.length, 1); assert.equal(h.state.positions, null);
  assert.equal(h.history.capture(h.projects, "Unknown", h.tasks, h.tasks[0]), null);
  assert.equal(h.history.capture(h.projects, "Project 2", h.tasks, { handle: {} }), null);
  assert.equal(h.history.capture(h.projects, "Project 2", h.tasks, { ...h.tasks[0], isDemo: true }), null);
  assert.equal(await h.history.remember(null), false);
});

test("a delayed read from the previous root cannot replace the current marks", async () => {
  const entered = deferred(), finish = deferred(), h = runtime();
  const old = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, { read() { entered.resolve(); return finish.promise; } });
  const latest = directory({ [LAST_OPENED_TASK_FILES.editor]: record(2, 2) });
  const pending = h.history.open(old); await entered.promise;
  await h.history.open(latest); finish.resolve(); await pending;
  assert.deepEqual(h.state.positions, { projectIndex: 2, taskIndex: 2 });
  assert.deepEqual(old.writes, []);
});

test("late read errors from the old root do not show a warning for the new root", async () => {
  const entered = deferred(), finish = deferred(), h = runtime();
  const old = directory({}, { lookup() { entered.resolve(); return finish.promise.then(() => { throw new Error("Old error"); }); } });
  const pending = h.history.open(old); await entered.promise;
  await h.history.open(directory()); finish.resolve(); await pending;
  assert.equal(h.state.notice, "");
});

test("a load captured before root reselection cannot write to either session", async () => {
  const root = directory(), h = runtime(); await h.history.open(root);
  const snapshot = h.capture(); await h.history.open(root);
  assert.equal(await h.history.remember(snapshot), false);
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(null, null));
});

test("a task opened during a delayed initial read wins over that read", async () => {
  const entered = deferred(), finish = deferred(), h = runtime();
  const root = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, { read() { entered.resolve(); return finish.promise; } });
  const reading = h.history.open(root); await entered.promise;
  const saving = h.history.remember(h.capture()); finish.resolve(); await Promise.all([reading, saving]);
  assert.deepEqual(h.state.positions, { projectIndex: 2, taskIndex: 2 });
  assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(2, 2));
});

test("a superseded delayed write is aborted so the newest opened task wins", async () => {
  const entered = deferred(), finish = deferred(), h = runtime(); let writes = 0, aborts = 0;
  const root = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, {
    write() { if (++writes === 1) { entered.resolve(); return finish.promise; } }, abort() { aborts++; },
  });
  await h.history.open(root);
  const old = h.history.remember(h.capture()); await entered.promise;
  const latest = h.history.remember(h.history.capture(h.projects, "Project 2", h.tasks, h.tasks[0]));
  finish.resolve(); assert.equal(await old, false); assert.equal(await latest, true);
  assert.equal(aborts, 1); assert.equal(root.files.get(LAST_OPENED_TASK_FILES.editor), record(1, 1));
});

test("changing roots aborts an old in-flight write and leaves the new root untouched", async () => {
  const entered = deferred(), finish = deferred(), h = runtime(); let aborts = 0;
  const old = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, {
    write() { entered.resolve(); return finish.promise; }, abort() { aborts++; },
  });
  await h.history.open(old);
  const saving = h.history.remember(h.capture()); await entered.promise;
  const latest = directory(); await h.history.open(latest); finish.resolve(); await saving;
  assert.equal(aborts, 1); assert.equal(old.files.get(LAST_OPENED_TASK_FILES.editor), record(1, 1));
  assert.equal(latest.files.get(LAST_OPENED_TASK_FILES.editor), record(null, null));
  assert.equal(h.state.positions, null);
});

test("dispose prevents pending reads and captured loads from updating a removed component", async () => {
  const entered = deferred(), finish = deferred(), h = runtime();
  const root = directory({ [LAST_OPENED_TASK_FILES.editor]: record(1, 1) }, { read() { entered.resolve(); return finish.promise; } });
  const pending = h.history.open(root); await entered.promise; const snapshot = h.capture();
  h.history.dispose(); finish.resolve(); await pending;
  assert.equal(await h.history.remember(snapshot), false); assert.equal(h.state.positions, null);
});
