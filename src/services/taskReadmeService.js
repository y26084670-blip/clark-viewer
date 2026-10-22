import { readTaskDocsText, TASK_DOCS_TEXT_MAX_BYTES } from "./taskDocsService.js";

const README = "README.txt";
const missing = error => error?.name === "NotFoundError";

// Reading never creates DOCS or requests write access.
export async function loadTaskReadme(task) {
  if (task?.kind !== "directory") throw new Error("Выберите локальное задание");
  let docs;
  try { docs = await task.getDirectoryHandle("DOCS"); }
  catch (error) {
    if (missing(error)) return { exists: false, name: README, text: "" };
    throw error;
  }
  const matches = [];
  for await (const [name, handle] of docs.entries()) {
    if (name.toLowerCase() === README.toLowerCase()) matches.push({ name, handle });
  }
  if (!matches.length) return { exists: false, name: README, text: "" };
  if (matches.length !== 1 || matches[0].handle.kind !== "file") {
    throw new Error("В DOCS неоднозначное имя README.txt или каталог с этим именем");
  }
  const { name, handle } = matches[0], file = await handle.getFile();
  const text = await readTaskDocsText({ kind: "file", name, getFile: async () => file });
  return { exists: true, name, text, size: file.size, lastModified: file.lastModified };
}

async function writeAccess(task) {
  // Called directly from Save/Delete, before any asynchronous file reads.
  const method = task?.requestPermission ?? task?.queryPermission;
  if (method && await method.call(task, { mode: "readwrite" }) !== "granted") {
    throw new Error("Нет разрешения на запись README.txt");
  }
}

async function verifySnapshot(task, expected) {
  if (!expected || typeof expected.exists !== "boolean") throw new Error("Сначала откройте README.txt");
  const current = await loadTaskReadme(task);
  if (current.exists !== expected.exists || current.name !== expected.name
    || current.text !== expected.text || current.size !== expected.size
    || current.lastModified !== expected.lastModified) {
    throw new Error("README.txt изменён после открытия. Закройте редактор и откройте файл заново; ваши изменения не записаны.");
  }
  return current;
}

export async function saveTaskReadme(task, expected, text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > TASK_DOCS_TEXT_MAX_BYTES) {
    throw new Error("Текст README.txt должен быть не больше 2 МиБ в UTF-8");
  }
  await writeAccess(task);
  const current = await verifySnapshot(task, expected);
  const docs = await task.getDirectoryHandle("DOCS", { create: true });
  const file = await docs.getFileHandle(current.name, { create: true });
  const stream = await file.createWritable({ keepExistingData: false });
  try { await stream.write(text); await stream.close(); }
  catch (error) {
    try { await stream.abort(); } catch { /* Keep the original write failure. */ }
    throw error;
  }
}

export async function deleteTaskReadme(task, expected) {
  await writeAccess(task);
  const current = await verifySnapshot(task, expected);
  if (!current.exists) throw new Error("README.txt уже отсутствует");
  const docs = await task.getDirectoryHandle("DOCS");
  await docs.removeEntry(current.name);
}
