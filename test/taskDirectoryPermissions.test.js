import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/tabs/Tasks.jsx", import.meta.url), "utf8");
const start = source.indexOf("  let revision = 0;");
const end = source.indexOf("  async function pickProject(name)", start);
assert.ok(start >= 0 && end > start);

// Run the actual picker and directory enumeration without mounting unrelated JSX.
const createPicker = new Function("dependencies", `
    const { window, setError, setRoot, setProjects, setProject, setTasks, setCandidate } = dependencies;
    ${source.slice(start, end)}
    return pickRoot;
`);

function directory(name, items = []) {
    return { name, kind: "directory", async *entries() {
        for (const item of items) yield [item.name, item];
    } };
}

function runtime(picker, windowOverrides = {}) {
    const state = { root: null, projects: [], project: "Previous", tasks: [1], candidate: 1, error: "", permissions: [] };
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
