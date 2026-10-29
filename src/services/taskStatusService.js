export const TASK_PLANAR_MODE_FILE = "_2d.e3d";

// These are existence checks only: no task contents, writes or permission prompts.
export const EMPTY_TASK_STATUS = Object.freeze({
  hasSolution: null, missingInput: null, hasGifs: null, hasComparison: null, omState: null, planar2D: null,
  errors: Object.freeze({}),
});

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("Проверка отменена", "AbortError");
}

export function unavailableTaskStatus(error) {
  const message = error?.message || "Не удалось проверить каталог задания";
  return { ...EMPTY_TASK_STATUS, errors: Object.fromEntries(
    ["hasSolution", "missingInput", "hasGifs", "hasComparison", "omState", "planar2D"].map(key => [key, message]),
  ) };
}

async function probe(parent, name, kind, signal) {
  checkAbort(signal);
  try {
    const handle = kind === "file"
      ? await parent.getFileHandle(name, { create: false })
      : await parent.getDirectoryHandle(name, { create: false });
    checkAbort(signal);
    return { exists: true, handle };
  } catch (error) {
    checkAbort(signal);
    if (error?.name === "AbortError") throw error;
    if (error?.name === "NotFoundError" || error?.name === "TypeMismatchError") return { exists: false };
    return { exists: null, error: error?.message || "Не удалось проверить наличие" };
  }
}

export async function readTaskPlanarMode(taskHandle, { signal } = {}) {
  const input = await probe(taskHandle, "input3XX", "directory", signal);
  return input.exists === true ? probe(input.handle, TASK_PLANAR_MODE_FILE, "file", signal) : input;
}

export async function readTaskStatus(taskHandle, { signal } = {}) {
  const [input, output, comparison] = await Promise.all([
    probe(taskHandle, "input3XX", "directory", signal),
    probe(taskHandle, "output3XX", "directory", signal),
    // Same task-root directory as Viewer taskTestProtocolService.
    probe(taskHandle, "comparison", "directory", signal),
  ]);
  const [summary, demo] = output.exists === true ? await Promise.all([
    probe(output.handle, "_summary_out.txt", "file", signal),
    probe(output.handle, "demo", "directory", signal),
  ]) : [output, output];
  const [activeOM, disabledOM, planar] = input.exists === true ? await Promise.all([
    probe(input.handle, "om-client.json", "file", signal),
    probe(input.handle, "_om-client.json", "file", signal),
    probe(input.handle, TASK_PLANAR_MODE_FILE, "file", signal),
  ]) : [input, input, input];
  const omState = activeOM.exists === true ? "active" : activeOM.exists === null ? null
    : disabledOM.exists === true ? "disabled" : disabledOM.exists === null ? null : "none";
  checkAbort(signal);
  const errors = {};
  const omError = activeOM.error || disabledOM.error;
  if (omError) errors.omState = omError;
  if (activeOM.exists === true && disabledOM.exists === true) {
    errors.omState = "Одновременно найдены om-client.json и _om-client.json. Активный селектор существует; устраните конфликт файлов.";
  }
  for (const [key, result] of [["missingInput", input], ["hasSolution", summary],
    ["hasGifs", demo], ["hasComparison", comparison], ["planar2D", planar]]) {
    if (result.error) errors[key] = result.error;
  }
  return {
    omState,
    planar2D: planar.exists,
    hasSolution: summary.exists,
    missingInput: input.exists === null ? null : !input.exists,
    hasGifs: demo.exists,
    hasComparison: comparison.exists,
    errors,
  };
}

export async function readTaskStatusEntry(entry, { signal } = {}) {
  if (entry.handle) return readTaskStatus(entry.handle, { signal });
  const parts = String(entry.path ?? "").replaceAll("\\", "/").split("/");
  if (!entry.root || parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    return unavailableTaskStatus(new Error("Некорректный относительный путь задания"));
  }
  let handle = entry.root;
  for (const part of parts) {
    const result = await probe(handle, part, "directory", signal);
    if (result.exists === null) return unavailableTaskStatus(new Error(result.error));
    if (!result.exists) return {
      hasSolution: false, missingInput: true, hasGifs: false, hasComparison: false, omState: "none", planar2D: false, errors: {},
    };
    handle = result.handle;
  }
  return readTaskStatus(handle, { signal });
}
