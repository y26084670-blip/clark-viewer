import test from "node:test";
import assert from "node:assert/strict";
import { readTaskDirectoryLists } from "../src/services/taskDirectoryRefresh.js";

function directory(name, children = []) {
  return { name, kind: "directory", children: new Map(children.map(child => [child.name, child])),
    async *entries() { yield* this.children; },
    async getDirectoryHandle(key) {
      if (!this.children.has(key)) throw Object.assign(new Error("Removed"), { name: "NotFoundError" });
      return this.children.get(key);
    } };
}
test("refresh reads created, removed and renamed tasks, including an initially empty project", async () => {
  const project = directory("Project"), root = directory("Root", [project]);
  const input = { root, projectName: "Project", projects: [{ name: project.name, handle: project }] };
  assert.deepEqual((await readTaskDirectoryLists(input)).tasks, []);
  project.children.set("Task10", directory("Task10")); project.children.set("Task2", directory("Task2"));
  project.children.set("note.txt", { name: "note.txt", kind: "file" });
  assert.deepEqual((await readTaskDirectoryLists(input)).tasks.map(x => x.name), ["Task2", "Task10"]);
  project.children.delete("Task2"); project.children.set("Renamed", directory("Renamed"));
  assert.deepEqual((await readTaskDirectoryLists(input)).tasks.map(x => x.name), ["Renamed", "Task10"]);
});
test("project refresh also refreshes the selected project's tasks and handles a removed project", async () => {
  const project = directory("Project", [directory("New task")]), root = directory("Root", [project, directory("Another")]);
  const input = { root, projectName: "Project", projects: [], refreshProjects: true };
  let result = await readTaskDirectoryLists(input);
  assert.deepEqual(result.projects.map(x => x.name), ["Another", "Project"]);
  assert.equal(result.tasks[0].name, "New task");
  root.children.delete("Project");
  result = await readTaskDirectoryLists(input);
  assert.equal(result.projectName, ""); assert.deepEqual(result.tasks, []);
});
test("lost permissions report an error instead of replacing the list with an empty snapshot", async () => {
  const root = { async getDirectoryHandle() { throw Object.assign(new Error("Denied"), { name: "NotAllowedError" }); } };
  await assert.rejects(readTaskDirectoryLists({ root, projectName: "Project", projects: [] }), /Denied/);
});
