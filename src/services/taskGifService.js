// GIF files belong to the selected task, outside editable input3XX data.
// Keep this filesystem-only module identical in E3D Editor and E3D Viewer.
export const TASK_GIF_MAX_BYTES = 128 * 1024 * 1024;
const DIRECTORY_PARTS = ["output3XX", "demo"];
const listeners = new Set();
let mutationQueue = Promise.resolve();

function assertCurrent(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Операция с GIF отменена"), { name: "AbortError" });
}

function isGifLeaf(name) {
  return typeof name === "string" && name.length > 4 && /\.gif$/i.test(name)
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(name);
}

function assertTaskHandle(taskHandle) {
  if (!taskHandle || taskHandle.kind !== "directory" || typeof taskHandle.getDirectoryHandle !== "function") {
    throw new Error("Выберите локальное задание для работы с GIF");
  }
}

// Called synchronously by save/delete before their first await. Requesting
// permission after directory or Blob reads would lose the click's activation.
function requestWritePermission(taskHandle, signal) {
  assertCurrent(signal); assertTaskHandle(taskHandle);
  if (typeof taskHandle.requestPermission !== "function") throw new Error("Для этого задания недоступно разрешение на запись");
  return taskHandle.requestPermission({ mode: "readwrite" });
}

function assertPermission(permission, signal) {
  assertCurrent(signal);
  if (permission !== "granted") throw new Error("Не предоставлено разрешение на запись в каталог задания");
}

function serializeMutation(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function gifDirectory(taskHandle, create, signal) {
  assertCurrent(signal); assertTaskHandle(taskHandle);
  let directory = taskHandle;
  for (const name of DIRECTORY_PARTS) {
    assertCurrent(signal);
    try { directory = await directory.getDirectoryHandle(name, { create }); }
    catch (error) {
      assertCurrent(signal);
      if (!create && error?.name === "NotFoundError") return null;
      throw error;
    }
    assertCurrent(signal);
  }
  return directory;
}

function notify() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A view error must not turn a committed file operation into a failure. */ }
  }
}

export function subscribeTaskGifs(listener) {
  if (typeof listener !== "function") throw new TypeError("Ожидался обработчик изменения GIF");
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function listTaskGifs(taskHandle, { signal } = {}) {
  assertCurrent(signal);
  if (!taskHandle) return [];
  const directory = await gifDirectory(taskHandle, false, signal);
  if (!directory) return [];
  const entries = [];
  for await (const [name, handle] of directory.entries()) {
    assertCurrent(signal);
    if (handle.kind === "file" && isGifLeaf(name)) entries.push({ name, handle });
  }
  assertCurrent(signal);
  return entries.sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }) || a.name.localeCompare(b.name, "ru"));
}

async function validateGif(blob, signal) {
  assertCurrent(signal);
  if (!(blob instanceof Blob) || blob.size < 6 || blob.size > TASK_GIF_MAX_BYTES) {
    throw new Error("GIF должен быть непустым файлом размером не более 128 МиБ");
  }
  const bytes = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  assertCurrent(signal);
  const signature = String.fromCharCode(...bytes);
  if (signature !== "GIF87a" && signature !== "GIF89a") throw new Error("Файл не содержит GIF87a или GIF89a");
  return blob;
}

export async function readTaskGif(fileHandle, { signal } = {}) {
  assertCurrent(signal);
  if (!fileHandle || fileHandle.kind !== "file" || !isGifLeaf(fileHandle.name)) throw new Error("Выберите GIF-файл задания");
  const file = await fileHandle.getFile();
  assertCurrent(signal);
  return validateGif(file, signal);
}

function suggestedLeaf(suggestedName) {
  let stem = String(suggestedName || "moview.gif").normalize("NFC").trim()
    .replace(/\.gif$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "").slice(0, 160).replace(/[\uD800-\uDBFF]$/u, "");
  if (!stem) stem = "moview";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  return `${stem}.gif`;
}

const comparisonName = name => name.normalize("NFC").toLowerCase();

async function occupiedNames(directory, signal) {
  const occupied = new Set();
  for await (const [name] of directory.entries()) { assertCurrent(signal); occupied.add(comparisonName(name)); }
  assertCurrent(signal);
  return occupied;
}

async function fileExists(directory, name, signal) {
  assertCurrent(signal);
  try { await directory.getFileHandle(name, { create: false }); assertCurrent(signal); return true; }
  catch (error) {
    assertCurrent(signal);
    if (error?.name === "NotFoundError") return false;
    if (error?.name === "TypeMismatchError") return true;
    throw error;
  }
}

async function sameFile(left, right) {
  if (typeof left?.isSameEntry === "function") return left.isSameEntry(right);
  if (typeof right?.isSameEntry === "function") return right.isSameEntry(left);
  return left === right;
}

async function removeCreatedFile(directory, name, handle, initialFile) {
  if (!directory || !name || !handle) return null;
  try {
    const current = await directory.getFileHandle(name, { create: false });
    if (!await sameFile(handle, current)) return null;
    const file = await current.getFile();
    // isSameEntry compares locators, not file versions. A visible change must
    // never be removed as our empty reservation. FSA offers no atomic
    // compare-and-delete, so an external writer can still race this check.
    if (file.size !== 0 || file.lastModified !== initialFile.lastModified) {
      return new Error("файл изменился после создания; он оставлен без удаления");
    }
    await directory.removeEntry(name, { recursive: false });
    return null;
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    return error; // A leftover file must not be silently described as cleaned up.
  }
}

export async function saveTaskGif(taskHandle, blob, suggestedName, { signal } = {}) {
  const permission = requestWritePermission(taskHandle, signal);
  assertPermission(await permission, signal);
  return serializeMutation(async () => {
    assertCurrent(signal);
    await validateGif(blob, signal);
    const directory = await gifDirectory(taskHandle, true, signal);
    const occupied = await occupiedNames(directory, signal);
    const base = suggestedLeaf(suggestedName), stem = base.slice(0, -4);
    let name, handle, initialFile, writable, unverifiedName, owned = false, aborting = null;
    const abortWrite = () => {
      if (!writable || aborting) return;
      try { aborting = Promise.resolve(writable.abort()).catch(() => {}); } catch { aborting = Promise.resolve(); }
    };
    signal?.addEventListener("abort", abortWrite, { once: true });
    try {
      for (let suffix = 1; suffix <= 100_000; suffix++) {
        const candidate = suffix === 1 ? base : `${stem}_${suffix}.gif`;
        if (occupied.has(comparisonName(candidate))) continue;
        if (await fileExists(directory, candidate, signal)) { occupied.add(comparisonName(candidate)); continue; }
        assertCurrent(signal);
        const created = await directory.getFileHandle(candidate, { create: true });
        // FSA has no exclusive-create primitive. Recheck content before owning
        // a newly obtained entry; refuse to overwrite a concurrently saved file.
        let existing;
        unverifiedName = candidate;
        try { existing = await created.getFile(); unverifiedName = null; }
        catch (error) {
          throw new Error(`Не удалось проверить созданный GIF «${candidate}». Возможно, в каталоге остался пустой файл; он не удалён, поскольку его содержимое не удалось проверить. ${error.message ?? error}`);
        }
        if (existing.size !== 0) { occupied.add(comparisonName(candidate)); assertCurrent(signal); continue; }
        name = candidate; handle = created; initialFile = existing; owned = true;
        assertCurrent(signal);
        break;
      }
      if (!handle) throw new Error("Не удалось выбрать свободное имя GIF");
      writable = await handle.createWritable({ keepExistingData: false });
      assertCurrent(signal);
      await writable.write(blob);
      assertCurrent(signal);
      await writable.close();
      writable = null;
      // Successful close is the commit point. A late cancellation must not
      // delete the saved file, even if its caller has moved to another task.
      owned = false;
      notify();
      assertCurrent(signal);
      return { name, handle };
    } catch (error) {
      abortWrite();
      if (aborting) await aborting;
      const cleanupError = owned ? await removeCreatedFile(directory, name, handle, initialFile) : null;
      if (cleanupError) throw new Error(`Не удалось убрать незавершённый GIF «${name}»: ${cleanupError.message ?? cleanupError}. Исходная ошибка: ${error.message ?? error}`);
      if (unverifiedName) throw error;
      assertCurrent(signal);
      throw error;
    } finally { signal?.removeEventListener("abort", abortWrite); }
  });
}

/** The UI obtains confirmation before calling this function. It can remove
 * only the selected GIF directly inside this task's output3XX/demo folder.
 */
export async function deleteTaskGif(taskHandle, entry, { signal } = {}) {
  if (!entry || !isGifLeaf(entry.name) || entry.handle?.kind !== "file") throw new Error("Удалять можно только выбранный GIF-файл");
  const permission = requestWritePermission(taskHandle, signal);
  assertPermission(await permission, signal);
  return serializeMutation(async () => {
    assertCurrent(signal);
    const directory = await gifDirectory(taskHandle, false, signal);
    if (!directory) throw new Error("Каталог GIF больше не существует");
    const current = await directory.getFileHandle(entry.name, { create: false });
    assertCurrent(signal);
    const same = await sameFile(entry.handle, current);
    assertCurrent(signal);
    if (!same) throw new Error("GIF был заменён. Обновите список и выберите файл заново.");
    await directory.removeEntry(entry.name, { recursive: false });
    // A deletion already committed while cancellation arrived cannot be undone.
    // Refresh observers, but do not publish it into the stale caller's context.
    notify();
    assertCurrent(signal);
  });
}
