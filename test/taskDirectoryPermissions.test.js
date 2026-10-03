import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/tabs/Tasks.jsx", import.meta.url), "utf8");
const start = source.indexOf("  let revision = 0;");
const end = source.indexOf("  async function pickProject(name)", start);
assert.ok(start >= 0 && end > start);

// Run the actual picker and directory enumeration without mounting unrelated JSX.
const createPicker = new Function("dependencies", `
    const { window, setError, setRoot, setProjects, setProject, setTasks, setCandidate, galleryBusy } = dependencies;
    ${source.slice(start, end)}
    return pickRoot;
`);

function directory(name, items = []) {
    return { name, kind: "directory", async *entries() {
        for (const item of items) yield [item.name, item];
    } };
}

function runtime(picker, windowOverrides = {}) {
    const state = { root: null, projects: [], project: "Previous", tasks: [1], candidate: 1, error: "", permissions: [], galleryBusy: false };
    const pick = createPicker({
        window: {
            isSecureContext: true,
            showDirectoryPicker: async options => {
                state.permissions.push(options);
                return picker();
            },
            ...windowOverrides,
        },
        setError: value => { state.error = value; },
        setRoot: value => { state.root = value; },
        setProjects: value => { state.projects = value; },
        setProject: value => { state.project = value; },
        setTasks: value => { state.tasks = value; },
        setCandidate: value => { state.candidate = value; },
        galleryBusy: () => state.galleryBusy,
    });
    return { state, pick };
}

test("viewer accepts any root name, lists sorted projects and requests only read access", async () => {
    for (const name of ["clark.projects", "Расчёты 2026", "custom-projects"]) {
        const handle = directory(name, [directory("Project 10"), { name: "note.txt", kind: "file" }, directory("Project 2")]);
        const { state, pick } = runtime(() => handle);
        await pick();
        assert.equal(state.root, handle);
        assert.deepEqual(state.projects.map(item => item.name), ["Project 2", "Project 10"]);
        assert.deepEqual(state.permissions, [{ mode: "read" }]);
        assert.equal(state.project, "");
        assert.deepEqual(state.tasks, []);
        assert.equal(state.candidate, null);
        assert.equal(state.error, "");
    }
});

test("cancelling the viewer picker preserves the previous selection", async () => {
    const { state, pick } = runtime(() => { throw new DOMException("Cancelled", "AbortError"); });
    const previous = directory("Previous");
    state.root = previous;
    await pick();
    assert.equal(state.root, previous);
    assert.equal(state.project, "Previous");
    assert.deepEqual(state.tasks, [1]);
    assert.equal(state.candidate, 1);
    assert.equal(state.error, "");
});

test("viewer still reports denied browser access and preserves the selection", async () => {
    const { state, pick } = runtime(() => { throw new DOMException("Access denied", "NotAllowedError"); });
    const previous = directory("Previous");
    state.root = previous;
    await pick();
    assert.equal(state.root, previous);
    assert.equal(state.project, "Previous");
    assert.equal(state.error, "Access denied");
});

test("viewer checks browser support and secure context before opening the picker", async () => {
    for (const overrides of [{ isSecureContext: false }, { showDirectoryPicker: undefined }]) {
        const { state, pick } = runtime(() => assert.fail("Unsupported picker must not open"), overrides);
        await pick();
        assert.equal(state.root, null);
        assert.deepEqual(state.permissions, []);
        assert.match(state.error, /HTTPS или localhost/u);
    }
});

test("viewer waits for GIF deletion before allowing a different root", async () => {
    const handle = directory("Next"), { state, pick } = runtime(() => handle);
    const previous = directory("Previous");state.root = previous;state.galleryBusy = true;
    await pick();assert.equal(state.root, previous);assert.deepEqual(state.permissions, []);
    state.galleryBusy = false;await pick();assert.equal(state.root, handle);
});

test("a delayed previous directory cannot replace the newest viewer selection", async () => {
    let finish, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const old = { name: "Old", async *entries() {
        entered();
        await pending;
        yield ["Old project", directory("Old project")];
    } };
    const latest = directory("Latest", [directory("New project")]);
    const handles = [old, latest];
    const { state, pick } = runtime(() => handles.shift());
    const firstPick = pick();
    await ready;
    await pick();
    finish();
    await firstPick;
    assert.equal(state.root, latest);
    assert.deepEqual(state.projects.map(item => item.name), ["New project"]);
    assert.equal(state.error, "");
});

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const loadStart = appSource.indexOf("  let loadRevision = 0, activeReader;");
const loadEnd = appSource.indexOf("  function changeTime(", loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart);
const createViewerLoad = new Function("dependencies", `
    const { loadTask, ResultService, mapResultObjects, setBusy, setError, setTime,
        setElements, setRegions, setCoils, setTask, setPath, setActive } = dependencies;
    ${appSource.slice(loadStart, loadEnd)}
    return load;
`);

function viewerLoadingRuntime(loadTask, openResults = async () => ({})) {
    const state = { active: 0, task: null, path: "", error: "", busy: false, opened: [], closedReaders: 0 };
    const load = createViewerLoad({
        loadTask, ResultService: class {
            open(files) { return openResults(files); }
            close() { state.closedReaders++; }
        }, mapResultObjects() {},
        setBusy: value => { state.busy = value; }, setError: value => { state.error = value; },
        setTime() {}, setElements() {}, setRegions() {}, setCoils() {},
        setTask: value => { state.task = value; }, setPath: value => { state.path = value; },
        setActive: value => { state.active = value; state.opened.push({ active: value, task: state.task, path: state.path }); },
    });
    return { state, load };
}

const viewerTaskData = (name, files = {}) => ({ name, files, elements: [], regions: [] });

test("viewer opens 3D only after the task and HDF5 metadata finish loading", async () => {
    let finish, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const metadata = new Promise(resolve => { finish = resolve; });
    const h = viewerLoadingRuntime(async () => viewerTaskData("New", { JE: {} }), () => { entered(); return metadata; });
    const loading = h.load({}, "Projects/New");
    await ready;
    assert.equal(h.state.active, 0); assert.equal(h.state.task, null);
    finish({}); await loading;
    assert.equal(h.state.active, 1); assert.equal(h.state.opened.length, 1);
    assert.equal(h.state.opened[0].task.name, "New"); assert.equal(h.state.opened[0].path, "Projects/New");
    assert.equal(h.state.busy, false);
    assert.match(source, /onClick=\{\(\) => \{ if \(!galleryBusy\(\)\) setCandidate\(\{ \.\.\.item \}\); \}\}/u);
});

test("viewer load errors preserve the current tab and previously loaded task", async () => {
    const h = viewerLoadingRuntime(async () => { throw new Error("Unreadable task"); });
    const previous = viewerTaskData("Previous");
    h.state.active = 4; h.state.task = previous; h.state.path = "Projects/Previous";
    await h.load({}, "Projects/Broken");
    assert.equal(h.state.active, 4); assert.equal(h.state.task, previous);
    assert.equal(h.state.path, "Projects/Previous"); assert.deepEqual(h.state.opened, []);
    assert.match(h.state.error, /Unreadable task/u);
});

test("stale viewer metadata cannot reopen 3D after the user chooses another tab", async () => {
    let finish, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const metadata = new Promise(resolve => { finish = resolve; });
    const h = viewerLoadingRuntime(async name => viewerTaskData(name, name === "Old" ? { JE: {} } : {}),
        () => { entered(); return metadata; });
    const old = h.load("Old", "Projects/Old"); await ready;
    await h.load("Latest", "Projects/Latest");
    h.state.active = 5;
    finish({}); await old;
    assert.equal(h.state.active, 5); assert.equal(h.state.task.name, "Latest");
    assert.equal(h.state.path, "Projects/Latest"); assert.equal(h.state.opened.length, 1);
    assert.equal(h.state.closedReaders, 1);
});
