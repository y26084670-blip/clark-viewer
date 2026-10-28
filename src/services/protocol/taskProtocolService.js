import { appendProtocolBlocks, newProtocol, parseProtocol, PROTOCOL_MAX_BYTES, PROTOCOL_SIZE_ERROR, serializeProtocol } from "./protocolDocument.js";
import { readProtocolVideos } from "./protocolMedia.js";
const missing = error => error?.name === "NotFoundError";
export function protocolFilename(value) {
  const name = String(value).trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) || !/^.+\.html$/i.test(name)) {
    throw new Error("Укажите имя файла с расширением .html без символов пути.");
  }
  return name;
}
async function docsDirectory(task, create = false) {
  if (!task?.handle) throw new Error("Загрузите локальное задание.");
  try { return await task.handle.getDirectoryHandle("DOCS", { create }); }
  catch (error) { if (!create && missing(error)) return null; throw error; }
}
export async function listTaskProtocols(task) {
  const directory = await docsDirectory(task), names = [];
  if (directory) for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file" && /\.html$/i.test(name)) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}
export async function readTaskProtocol(task, filename) {
  const name = protocolFilename(filename), directory = await docsDirectory(task);
  if (!directory) return null;
  let handle;
  try { handle = await directory.getFileHandle(name); }
  catch (error) { if (missing(error)) return null; throw error; }
  const file = await handle.getFile();
  if (file.size > PROTOCOL_MAX_BYTES) throw new Error(PROTOCOL_SIZE_ERROR);
  const html = await file.text();
  return { name, html, document: parseProtocol(html) };
}
export async function readProtocolConditions(task) {
  try {
    const output = await task.handle.getDirectoryHandle("output3XX");
    const file = await (await output.getFileHandle("conditions.json")).getFile();
    if (file.size > 2 * 1024 * 1024) throw new Error("conditions.json превышает 2 МиБ.");
    return { id: crypto.randomUUID(), kind: "text", title: "Условия расчёта · output3XX/conditions.json",
      comment: "Содержимое файла на момент добавления в протокол.", text: await file.text() };
  } catch (error) { if (missing(error)) return null; throw error; }
}
export async function createTaskProtocol(task, snapshots = [], { signal } = {}) {
  signal?.throwIfAborted();
  let path = task.plotLabel || task.name || task.handle.name;
  const root = task.workspace?.rootHandle;
  if (root) {
    const parts = await root.resolve(task.handle);
    if (!parts) throw new Error("Загруженное задание находится вне базового каталога.");
    path = [root.name, ...parts].join("/");
  }
  const conditions = await readProtocolConditions(task);
  signal?.throwIfAborted();
  const draft = newProtocol(path, [...(conditions ? [conditions] : []), ...snapshots]);
  const baseBytes = new TextEncoder().encode(serializeProtocol(draft)).length;
  const videos = await readProtocolVideos(task, PROTOCOL_MAX_BYTES - baseBytes, { signal });
  const document = appendProtocolBlocks(draft, videos);
  // Check the exact serialized size, including names, comments and JSON.
  serializeProtocol(document);
  return document;
}
export async function saveTaskProtocol(task, filename, document, expectedHtml, { signal } = {}) {
  // Ask in the click handler's activation, before asynchronous reads.
  const permission = task?.handle?.requestPermission?.({ mode: "readwrite" });
  if (!permission || await permission !== "granted") throw new Error("Разрешите запись в каталог задания.");
  signal?.throwIfAborted();
  const name = protocolFilename(filename);
  const updated = { ...document, updatedAt: new Date().toISOString() };
  const html = serializeProtocol(updated);
  const current = await readTaskProtocol(task, name);
  if ((current?.html ?? null) !== expectedHtml) throw new Error("Файл уже существует или изменён после открытия. Откройте его заново либо выберите новое имя.");
  signal?.throwIfAborted();
  const directory = await docsDirectory(task, true);
  let file, created = false, writer;
  try {
    file = await directory.getFileHandle(name);
    if (!current) throw new Error("Файл появился во время сохранения. Выберите новое имя.");
  } catch (error) {
    if (!missing(error)) throw error;
    if (current) throw new Error("Файл удалён после открытия. Выберите новое имя.");
    file = await directory.getFileHandle(name, { create: true }); created = true;
  }
  try {
    writer = await file.createWritable();
    await writer.write(html); signal?.throwIfAborted(); await writer.close();
  } catch (error) {
    await writer?.abort().catch(() => {});
    // Abort preserves an existing file. A newly created empty entry otherwise
    // blocks retrying the same name; remove only that same, still-empty entry.
    if (created) try {
      const latest = await directory.getFileHandle(name);
      if (await latest.isSameEntry(file) && (await latest.getFile()).size === 0) await directory.removeEntry(name);
    } catch { /* Preserve the original write error and any external replacement. */ }
    throw error;
  }
  return { name, html, document: updated };
}
