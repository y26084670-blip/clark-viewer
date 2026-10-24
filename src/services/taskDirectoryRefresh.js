import { sortTaskDirectories } from "./taskLastOpenedService.js";

async function directories(handle) {
  const entries = [];
  for await (const [name, child] of handle.entries()) {
    if (child.kind === "directory") entries.push({ name, handle: child });
  }
  return sortTaskDirectories(entries);
}

// Read a fresh directory snapshot before committing UI state. Never reload the
// model currently open for editing or viewing as a side effect of refreshing.
export async function readTaskDirectoryLists({ root, projectName, projects, refreshProjects = false }) {
  let nextProjects = refreshProjects ? await directories(root) : projects;
  let tasks = [];
  if (projectName && (!refreshProjects || nextProjects.some(item => item.name === projectName))) {
    try {
      const handle = await root.getDirectoryHandle(projectName);
      tasks = await directories(handle);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      nextProjects = nextProjects.filter(item => item.name !== projectName);
      projectName = "";
    }
  } else projectName = "";
  return { projects: nextProjects, projectName, tasks };
}
