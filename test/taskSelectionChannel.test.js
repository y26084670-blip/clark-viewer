import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskSelectionChannel, readTaskSelection, TASK_SELECTION_CHANNEL } from "../src/services/taskSelectionChannel.js";

function directory(name, children = [], options = {}) {
  return { name, kind: "directory", identity: options.identity ?? {},
    async isSameEntry(other) { return this.identity === other.identity; },
    async queryPermission(descriptor) {
      assert.deepEqual(descriptor, { mode: "read" });
      return options.permission ?? "granted";
    },
    async *entries() {
      await options.beforeRead?.();
      if (options.error) throw options.error;
      for (const child of children) yield [child.name, child];
    },
  };
}
const selection = baseHandle => ({ baseHandle, projectName: "Проект 10", taskName: "Задание 2" });
function fixture() {
  const task = directory("Задание 2"), project = directory("Проект 10", [directory("Задание 10"), task]);
  const root = directory("clark.projects", [project, { name: "ignore.txt", kind: "file" }, directory("Проект 2")]);
  return { root, project, task };
}
function bus() {
  const channels = new Set(), messages = [];
  class Channel {
    constructor(name) { assert.equal(name, TASK_SELECTION_CHANNEL); channels.add(this); }
    postMessage(message) {
      messages.push(message);
      for (const other of channels) if (other !== this) queueMicrotask(() => other.onmessage?.({ data: message }));
    }
    close() { channels.delete(this); }
  }
  return { Channel, channels, messages };
}

test("fresh directories select names in natural order using receiver handles", async () => {
  const { root, project, task } = fixture();
  const remoteHandle = { identity: root.identity };
  const result = await readTaskSelection(root, selection(remoteHandle));
  assert.deepEqual(result.projects.map(item => item.name), ["Проект 2", "Проект 10"]);
  assert.deepEqual(result.tasks.map(item => item.name), ["Задание 2", "Задание 10"]);
  assert.equal(result.project.handle, project); assert.equal(result.task.handle, task);
});

test("different roots with identical names fail before directory enumeration", async () => {
  let reads = 0;
  const root = directory("clark.projects", [], { beforeRead: () => reads++ });
  await assert.rejects(readTaskSelection(root, selection(directory(root.name))), /разные базовые/u);
  assert.equal(reads, 0);
});

test("missing root and lost permissions require explicit directory selection", async () => {
  const { root } = fixture();
  await assert.rejects(readTaskSelection(null, selection(root)), /не выбран/u);
  for (const permission of ["prompt", "denied"]) {
    const handle = directory("clark.projects", [], { permission });
    await assert.rejects(readTaskSelection(handle, selection(handle)), /Доступ.*утрачен/u);
  }
});

test("missing projects and tasks give distinct errors", async () => {
  const { root } = fixture();
  await assert.rejects(readTaskSelection(root, { ...selection(root), projectName: "Нет проекта" }), /Проект.*отсутствует/u);
  await assert.rejects(readTaskSelection(root, { ...selection(root), taskName: "Нет задания" }), /Задание.*отсутствует/u);
});

test("access errors and stale directory reads cannot apply a selection", async () => {
  const denied = directory("base", [], { error: new DOMException("Denied", "NotAllowedError") });
  await assert.rejects(readTaskSelection(denied, selection(denied)), /Нет доступа/u);
  let current = true;
  const stale = directory("base", [], { beforeRead: () => { current = false; } });
  await assert.rejects(readTaskSelection(stale, selection(stale), { isCurrent: () => current }), /отменён/u);
});

test("invalid names never traverse outside the expected project/task levels", async () => {
  const { root } = fixture();
  for (const taskName of ["", ".", "..", "x/y", "x\\y", "\0", null]) {
    await assert.rejects(readTaskSelection(root, { ...selection(root), taskName }), /некорректная/u);
  }
});

test("both directions receive and acknowledge exactly once without echo requests", async () => {
  const transport = bus(), received = [], focused = [], { root } = fixture();
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel,
    onSelection: async request => { received.push("editor"); await readTaskSelection(root, request); },
    focusWindow() { assert.equal(received.at(-1), "editor"); focused.push("editor"); } });
  const viewer = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: transport.Channel,
    onSelection: async request => { received.push("viewer"); await readTaskSelection(root, request); },
    focusWindow() { assert.equal(received.at(-1), "viewer"); focused.push("viewer"); } });
  try {
    await editor.select(selection(root)); await viewer.select(selection(root));
    assert.deepEqual(received, ["viewer", "editor"]);
    assert.deepEqual(focused, ["viewer", "editor"]);
    assert.deepEqual(transport.messages.map(item => item.type), ["select-task", "selection-result", "select-task", "selection-result"]);
    assert.notEqual(transport.messages[0].requestId, transport.messages[2].requestId);
  } finally { editor.dispose(); viewer.dispose(); }
});

test("receiver failures reach the sender", async () => {
  const transport = bus(), { root } = fixture();
  let focused = false;
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel });
  const viewer = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: transport.Channel,
    onSelection() { throw new Error("Viewer занят"); }, focusWindow() { focused = true; } });
  try { await assert.rejects(editor.select(selection(root)), /Viewer занят/u); assert.equal(focused, false); }
  finally { editor.dispose(); viewer.dispose(); }
});

test("concurrent incoming requests cannot overtake an active selection", async () => {
  const transport = bus(), { root } = fixture();
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel });
  const viewer = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: transport.Channel,
    async onSelection() { started(); await pause; } });
  try {
    const first = editor.select(selection(root)); await begun;
    await assert.rejects(editor.select(selection(root)), /предыдущего перехода/u);
    release(); await first;
  } finally { release(); editor.dispose(); viewer.dispose(); }
});

test("wrong targets, unknown versions and unrelated responses are ignored", async () => {
  const transport = bus(); let called = 0;
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel,
    onSelection() { called++; } });
  const remote = new transport.Channel(TASK_SELECTION_CHANNEL);
  try {
    const message = { version: 1, type: "select-task", source: "viewer", target: "editor", requestId: "test" };
    remote.postMessage({ ...message, target: "viewer" });
    remote.postMessage({ ...message, source: "editor" });
    remote.postMessage({ ...message, version: 2 });
    remote.postMessage({ ...message, type: "selection-result", ok: true });
    await new Promise(resolve => queueMicrotask(resolve)); assert.equal(called, 0);
  } finally { remote.close(); editor.dispose(); }
});

test("closed peer times out and disposal rejects pending requests and closes the channel", async () => {
  const transport = bus(), { root } = fixture();
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel, timeoutMs: 5 });
  await assert.rejects(editor.select(selection(root)), /Viewer не ответил/u);
  const pending = editor.select(selection(root)); editor.dispose();
  await assert.rejects(pending, /Страница закрыта/u); assert.equal(transport.channels.size, 0);
});

test("unsupported channels and cloning failures report errors without leaving timers", async () => {
  const { root } = fixture();
  const unsupported = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: null });
  assert.equal(unsupported.supported, false);
  await assert.rejects(unsupported.select(selection(root)), /недоступен/u); unsupported.dispose();
  class BrokenChannel { postMessage() { throw new DOMException("Cannot clone", "DataCloneError"); } close() {} }
  const broken = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: BrokenChannel });
  await assert.rejects(broken.select(selection(root)), /передать команду.*Cannot clone/u); broken.dispose();
});


test("blocked window focus does not fail or repeat a successful selection", async () => {
  const transport = bus(), { root } = fixture(); let selected = 0, focused = 0;
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel });
  const viewer = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: transport.Channel,
    async onSelection(request) { await readTaskSelection(root, request); selected++; },
    focusWindow() { focused++; throw new DOMException("Blocked", "NotAllowedError"); } });
  try {
    await editor.select(selection(root));
    assert.equal(selected, 1); assert.equal(focused, 1);
    assert.equal(transport.messages.at(-1).ok, true);
  } finally { editor.dispose(); viewer.dispose(); }
});

test("a receiver disposed during selection cannot raise a stale tab", async () => {
  const transport = bus(), { root } = fixture(); let focused = 0;
  const editor = createTaskSelectionChannel({ app: "editor", BroadcastChannelClass: transport.Channel, timeoutMs: 5 });
  const viewer = createTaskSelectionChannel({ app: "viewer", BroadcastChannelClass: transport.Channel,
    onSelection() { viewer.dispose(); }, focusWindow() { focused++; } });
  try { await assert.rejects(editor.select(selection(root)), /Viewer не ответил/u); assert.equal(focused, 0); }
  finally { editor.dispose(); viewer.dispose(); }
});
