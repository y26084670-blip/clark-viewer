import { loadTask } from "../taskLoadService.js";
import { sortTaskDirectories } from "../taskLastOpenedService.js";
import { ResultService } from "../resultService.js";
import { mapResultObjects } from "./resultMappings.js";
import { loadLatestOMChannels } from "./omResultChannels.js";

async function directories(handle) {
  const rows = [];
  for await (const [name, child] of handle.entries()) {
    if (child.kind === "directory") rows.push({ name, handle: child });
  }
  return sortTaskDirectories(rows);
}

// Match the two-level project/task layout of the task browser, in one list.
export async function listPlotTasks(root) {
  const rows = [];
  if (!root) return rows;
  for (const project of await directories(root)) {
    for (const task of await directories(project.handle)) {
      const key = `${project.name}/${task.name}`;
      rows.push({ ...task, root, key, label: key });
    }
  }
  return rows;
}

export async function openPlotTask(entry, {
  load = loadTask, createReader = () => new ResultService(), loadOM = loadLatestOMChannels,
} = {}) {
  let reader;
  try {
    const data = await load(entry.handle);
    let metadata = {};
    if (Object.keys(data.files).length) {
      reader = createReader();
      metadata = await reader.open(data.files);
    }
    for (const [name, info] of Object.entries(metadata)) {
      if (!info.error && ["MH", "JE", "HS", "AS", "HV", "AV", "Q"].includes(name)) {
        try { mapResultObjects(data, name, info.header); }
        catch (error) { info.error = error.message; }
      }
    }
    const task = { ...data, reader, metadata, plotEntry: entry, plotSources: [], plotSourceError: "" };
    // An invalid optional OM result must not hide valid standard channels.
    try { const source = await loadOM(task); if (source) task.plotSources.push(source); }
    catch (error) { task.plotSourceError = error.message; }
    return task;
  } catch (error) { reader?.close(); throw error; }
}

// Owned by App: curves survive tab unmounts, but unused HDF5 workers do not.
export function createPlotTaskStore({ open = openPlotTask, onChange = () => {} } = {}) {
  const tasks = new Set();
  let retained = new Set(), selected = null, revision = 0;
  function collect() {
    for (const task of tasks) if (task !== selected && !retained.has(task)) {
      task.reader?.close(); tasks.delete(task);
    }
  }
  async function select(entry) {
    const current = ++revision;
    const cached = entry && [...tasks].find(task => task.plotEntry.root === entry.root && task.plotEntry.key === entry.key);
    selected = cached || null;
    collect();
    onChange({ entry, task: selected, loading: Boolean(entry && !cached), error: "" });
    if (!entry || cached) return selected;
    try {
      const task = await open(entry);
      if (current !== revision) { task.reader?.close(); return null; }
      tasks.add(task); selected = task;
      onChange({ entry, task, loading: false, error: "" });
      return task;
    } catch (error) {
      if (current === revision) onChange({ entry, task: null, loading: false, error: error.message });
      return null;
    }
  }
  return {
    select,
    retain(values) { retained = new Set(values.filter(Boolean)); collect(); },
    clear() { revision++; selected = null; retained.clear(); collect(); onChange({ entry: null, task: null, loading: false, error: "" }); },
  };
}
