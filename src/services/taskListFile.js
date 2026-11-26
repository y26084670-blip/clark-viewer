import { isProjectCatalog, readTaskQueueCatalog } from "./projectDiskAccessService.js";
export const TASK_LIST_FILE = "clark.tasks.txt";
export const PROOF_FILE = "clark.launch.json";
const pathKey = path => path.toLowerCase();

export function requireRoot(root) {
  if (!root || root.kind !== "directory") {
    throw new Error("Выберите базовый каталог с проектами.");
  }
}

function normalizeTaskPath(value) {
  if (typeof value !== "string") throw new Error("Путь задания должен быть текстом.");
  const path = value.trim().replaceAll("\\", "/");
  const segments = path.split("/");
  const sibling = segments[0] === "..";
  const taskSegments = sibling ? segments.slice(2) : segments;
  if ((sibling && (segments.length !== 4 || !isProjectCatalog(segments[1])))
    || taskSegments.length < 2 || taskSegments.some(segment => (
    !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/.test(segment)
  ))) {
    throw new Error("Ожидается путь «проект/задание» или «../clark.каталог/проект/задание».");
  }
  return segments.join("/");
}

export async function readTextFile(root, name) {
  requireRoot(root);
  try {
    const handle = await root.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

export async function writeTextFile(root, name, text, { create = true } = {}) {
  requireRoot(root);
  const handle = await root.getFileHandle(name, { create });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

function collectEntries(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const path = normalizeTaskPath(entry.path);
    const key = pathKey(path);
    const previous = unique.get(key);
    unique.set(key, {
      path: previous?.path ?? path,
      // A duplicate disabled line must not accidentally enable the same task.
      enabled: entry.enabled === true && (previous?.enabled ?? true),
    });
  }
  return [...unique.values()];
}

function parseTaskList(text, { tolerateInvalid = false } = {}) {
  const entries = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const enabled = !line.startsWith("*");
    try {
      entries.push({
        path: normalizeTaskPath(enabled ? line : line.slice(1).trim()),
        enabled,
      });
    } catch (error) {
      if (tolerateInvalid) continue;
      throw new Error(
        `Некорректная строка ${index + 1} в «${TASK_LIST_FILE}». `
        + `${error.message} Перетащите задания для формирования нового списка.`,
      );
    }
  }
  return collectEntries(entries);
}

export async function readTaskList(root) {
  const text = await readTextFile(root, TASK_LIST_FILE);
  return { exists: text !== null, entries: text === null ? [] : parseTaskList(text) };
}

export async function invalidateLaunchRequest(root) {
  try {
    // Close the invalidation before changing the list that a launch could read.
    await writeTextFile(root, PROOF_FILE, "", { create: false });
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

export async function writeTaskList(root, entries) {
  const normalized = collectEntries(entries);
  const text = normalized.map(entry => `${entry.enabled ? "" : "*"}${entry.path}`).join("\n");
  await invalidateLaunchRequest(root);
  await writeTextFile(root, TASK_LIST_FILE, text ? text + "\n" : "");
  return { exists: true, entries: normalized };
}

export async function refreshTaskList(root) {
  requireRoot(root);
  const previousText = await readTextFile(root, TASK_LIST_FILE);
  // Update is the explicit way to replace invalid/obsolete rows with actual tasks.
  const previous = new Map(
    parseTaskList(previousText ?? "", { tolerateInvalid: true })
      .map(entry => [pathKey(entry.path), entry.enabled]),
  );
  const discovered = [];
  // Match the project/task discovery used by Tasks, including pre-import tasks.
  for await (const [projectName, project] of root.entries()) {
    if (project.kind !== "directory") continue;
    for await (const [taskName, task] of project.entries()) {
      if (task.kind !== "directory") continue;
      const path = normalizeTaskPath(`${projectName}/${taskName}`);
      discovered.push({ path, enabled: previous.get(pathKey(path)) ?? false });
    }
  }
  discovered.sort((left, right) => (
    left.path.localeCompare(right.path, "ru", { numeric: true, sensitivity: "base" })
    || left.path.localeCompare(right.path, "ru")
  ));
  return writeTaskList(root, discovered);
}

export function setTaskListEntriesEnabled(root, entries, selectedPaths, enabled) {
  const selected = new Set([...selectedPaths].map(path => pathKey(normalizeTaskPath(path))));
  return writeTaskList(root, entries.map(entry => ({
    ...entry,
    enabled: selected.has(pathKey(entry.path)) ? enabled === true : entry.enabled,
  })));
}

export async function createTaskQueueEntry(queueRoot, disk, source) {
  const root = source?.rootHandle;
  if (!queueRoot || !disk || !root || !source.handle || !isProjectCatalog(root.name)) {
    throw new Error("Перетащите задание из списка выбранного проекта.");
  }
  const [origin, location, parts] = await Promise.all([
    disk.resolve(queueRoot), disk.resolve(root), root.resolve(source.handle),
  ]);
  if (origin?.length !== 1 || location?.length !== 1 || parts?.length !== 2
    || pathKey(origin[0]) !== pathKey(queueRoot.name) || pathKey(location[0]) !== pathKey(root.name)) {
    throw new Error("Задание должно находиться в каталоге с проектами выбранного диска.");
  }
  const taskPath = parts.join("/");
  const sameCatalog = pathKey(origin[0]) === pathKey(location[0]);
  return { path: sameCatalog ? taskPath : `../${location[0]}/${taskPath}`, enabled: true };
}

export async function restoreTaskQueueRoot(disk, catalogs, readCatalog = readTaskQueueCatalog) {
  const saved = await readCatalog(disk);
  const remembered = catalogs.find(item => pathKey(item.name) === pathKey(saved ?? ""));
  if (remembered) return remembered.handle;
  // До появления сохранённого адреса используем последний записанный список.
  const lists = await Promise.all(catalogs.map(async catalog => {
    try {
      const file = await (await catalog.handle.getFileHandle("clark.tasks.txt")).getFile();
      return { handle: catalog.handle, modified: file.lastModified };
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
  }));
  return lists.filter(Boolean).sort((left, right) => right.modified - left.modified)[0]?.handle ?? null;
}


export async function changeTaskList(root, update) {
  const change = async () => writeTaskList(root, update((await readTaskList(root)).entries));
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request("clark.task-list/" + pathKey(root.name), change) : change();
}
