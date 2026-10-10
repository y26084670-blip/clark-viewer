// Standalone test reports live in comparison directly below the task directory.
const DIRECTORY_PARTS = ["comparison"];

function assertCurrent(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Поиск протоколов тестов отменён"), { name: "AbortError" });
}

function isHtmlLeaf(name) {
  return typeof name === "string" && /\.html$/i.test(name) && !/[/\\\u0000]/u.test(name);
}

async function protocolDirectory(taskHandle, signal) {
  if (taskHandle.kind !== "directory" || typeof taskHandle.getDirectoryHandle !== "function") {
    throw new Error("Выберите локальное задание для просмотра протоколов тестов");
  }
  let directory = taskHandle;
  for (const name of DIRECTORY_PARTS) {
    assertCurrent(signal);
    try { directory = await directory.getDirectoryHandle(name, { create: false }); }
    catch (error) {
      assertCurrent(signal);
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
    assertCurrent(signal);
  }
  return directory;
}

async function collectProtocols(directory, prefix, signal) {
  assertCurrent(signal);
  const protocols = [];
  try {
    for await (const [name, handle] of directory.entries()) {
      assertCurrent(signal);
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        protocols.push(...await collectProtocols(handle, path, signal));
        assertCurrent(signal);
      } else if (handle.kind === "file" && isHtmlLeaf(name)) {
        protocols.push({ name, path, handle });
      }
    }
    // An empty iterator can finish after its task has already been changed.
    assertCurrent(signal);
    return protocols;
  } catch (error) {
    assertCurrent(signal);
    // A directory removed during discovery contributes no stale reports.
    if (error?.name === "NotFoundError") return [];
    throw error;
  }
}

function comparePaths(left, right) {
  return left.path.localeCompare(right.path, "ru", { numeric: true, sensitivity: "base" })
    || left.path.localeCompare(right.path, "ru", { numeric: true, sensitivity: "variant" })
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function listTaskTestProtocols(taskHandle, { signal } = {}) {
  assertCurrent(signal);
  if (!taskHandle) return [];
  const directory = await protocolDirectory(taskHandle, signal);
  assertCurrent(signal);
  if (!directory) return [];
  const protocols = await collectProtocols(directory, "", signal);
  assertCurrent(signal);
  return protocols.sort(comparePaths);
}

export async function readTaskTestProtocol(fileHandle, { signal } = {}) {
  assertCurrent(signal);
  if (!fileHandle || fileHandle.kind !== "file" || !isHtmlLeaf(fileHandle.name) || typeof fileHandle.getFile !== "function") {
    throw new Error("Выберите HTML-файл протокола теста");
  }
  let file;
  try { file = await fileHandle.getFile(); }
  catch (error) { assertCurrent(signal); throw error; }
  assertCurrent(signal);
  // Do not decode/re-encode HTML: its own charset and all embedded data stay intact.
  return new Blob([file], { type: "text/html" });
}
