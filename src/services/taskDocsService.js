// Documentation directly under <task>/DOCS; deletion requires explicit confirmation in the UI.
export const TASK_DOCS_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
export const TASK_DOCS_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const TASK_DOCS_HTML_MAX_BYTES = 64 * 1024 * 1024;
const imageTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function assertCurrent(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Чтение DOCS отменено"), { name: "AbortError" });
}
function extension(name) {
  if (typeof name !== "string" || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)) return "";
  return /^.+\.([^.]+)$/u.exec(name)?.[1].toLowerCase() ?? "";
}
const compare = (a, b) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" })
  || a.name.localeCompare(b.name, "ru");

export async function listTaskDocs(taskHandle, { signal } = {}) {
  assertCurrent(signal);
  if (!taskHandle) return { images: [], documents: [] };
  if (taskHandle.kind !== "directory" || typeof taskHandle.getDirectoryHandle !== "function") {
    throw new Error("Выберите локальное задание для просмотра DOCS");
  }
  let directory;
  try { directory = await taskHandle.getDirectoryHandle("DOCS", { create: false }); }
  catch (error) {
    assertCurrent(signal);
    if (error?.name === "NotFoundError") return { images: [], documents: [] };
    throw error;
  }
  assertCurrent(signal);
  const images = [], documents = [];
  for await (const [name, handle] of directory.entries()) {
    assertCurrent(signal);
    if (handle.kind !== "file") continue;
    const ext = extension(name), entry = { name, handle };
    if (Object.hasOwn(imageTypes, ext)) images.push(entry);
    else if (["txt", "md", "html", "htm"].includes(ext)) documents.push(entry);
  }
  assertCurrent(signal);
  return { images: images.sort(compare), documents: documents.sort(compare) };
}

export function preferredTaskDoc(documents, previousName) {
  return documents.find(entry => entry.name === previousName)
    ?? documents.find(entry => entry.name.toLowerCase() === "readme.txt")
    ?? documents.find(entry => entry.name.toLowerCase() === "readme.md")
    ?? documents[0] ?? null;
}

// Capture the exact selected file without decoding it or applying preview limits.
export async function loadTaskDocSnapshot(task, name) {
  if (task?.kind !== "directory") throw new Error("Выберите локальное задание");
  if (!["txt", "md", "html", "htm"].includes(extension(name))) throw new Error("Выберите документ TXT, MD или HTML в DOCS");
  const directory = await task.getDirectoryHandle("DOCS", { create: false });
  const handle = await directory.getFileHandle(name, { create: false });
  const file = await handle.getFile();
  return { task, directory, handle, name, file };
}

export async function deleteTaskDoc(task, expected) {
  if (!expected || expected.task !== task || !(expected.file instanceof Blob)) {
    throw new Error("Сначала откройте подтверждение удаления документа");
  }
  // Request permission from the confirmation click, before any asynchronous reads.
  const permission = task.requestPermission ?? task.queryPermission;
  if (permission && await permission.call(task, { mode: "readwrite" }) !== "granted") {
    throw new Error(`Нет разрешения на удаление ${expected.name}`);
  }
  const current = await loadTaskDocSnapshot(task, expected.name);
  const conflict = () => new Error(`${expected.name} изменён после открытия. Закройте подтверждение и выберите файл заново.`);
  if (current.file.size !== expected.file.size || current.file.lastModified !== expected.file.lastModified
    || (current.handle.isSameEntry && !await current.handle.isSameEntry(expected.handle))) throw conflict();
  // Compare bytes in bounded chunks, including files that cannot be previewed as UTF-8.
  for (let offset = 0; offset < current.file.size; offset += 64 * 1024) {
    const [before, after] = await Promise.all([expected.file, current.file]
      .map(file => file.slice(offset, offset + 64 * 1024).arrayBuffer()));
    const bytes = new Uint8Array(after);
    if (!new Uint8Array(before).every((value, index) => value === bytes[index])) throw conflict();
  }
  await current.directory.removeEntry(current.name);
}

export async function readTaskDocsImage(handle, { signal } = {}) {
  assertCurrent(signal);
  const ext = extension(handle?.name);
  if (handle?.kind !== "file" || !Object.hasOwn(imageTypes, ext)) throw new Error("Выберите PNG, JPEG или WebP в DOCS");
  const file = await handle.getFile();
  assertCurrent(signal);
  if (!(file instanceof Blob) || file.size === 0 || file.size > TASK_DOCS_IMAGE_MAX_BYTES) {
    throw new Error("Изображение DOCS должно быть непустым файлом размером не более 64 МиБ");
  }
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  assertCurrent(signal);
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const valid = ext === "png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    : ext === "webp" ? bytes.length === 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new Error("Содержимое изображения не соответствует расширению PNG, JPEG или WebP");
  return file.slice(0, file.size, imageTypes[ext]);
}

export async function readTaskDocsText(handle, { signal } = {}) {
  assertCurrent(signal);
  if (handle?.kind !== "file" || !["txt", "md"].includes(extension(handle.name))) throw new Error("Выберите TXT или MD в DOCS");
  return readUtf8(handle, TASK_DOCS_TEXT_MAX_BYTES, "Текст DOCS превышает 2 МиБ", signal);
}

// HTML protocols embed their images and therefore use the protocol file limit.
// This returns source text only; the UI renders it in an isolated static preview.
export async function readTaskDocsDocument(handle, { signal } = {}) {
  assertCurrent(signal);
  if (["txt", "md"].includes(extension(handle?.name))) return readTaskDocsText(handle, { signal });
  if (handle?.kind !== "file" || !["html", "htm"].includes(extension(handle.name))) throw new Error("Выберите TXT, MD или HTML в DOCS");
  return readUtf8(handle, TASK_DOCS_HTML_MAX_BYTES, "HTML в DOCS превышает 64 МиБ", signal);
}

async function readUtf8(handle, maximum, limitMessage, signal) {
  const file = await handle.getFile();
  assertCurrent(signal);
  if (!(file instanceof Blob) || file.size > maximum) throw new Error(limitMessage);
  const bytes = await file.arrayBuffer();
  assertCurrent(signal);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Текст DOCS должен быть сохранён в UTF-8"); }
}
