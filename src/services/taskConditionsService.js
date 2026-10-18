const WORKSPACE = "clark.workspace.json";
const REQUEST = "clark.conditions-request.json";
const RESULT = "clark.conditions-result.json";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = error => error?.name === "NotFoundError";

async function readJson(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  return JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
}

export function parseConditionsMpiRanks(value) {
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > 2147483647) {
    throw new Error("Введите положительное целое число использованных MPI-процессов.");
  }
  return Number(text);
}

export async function readConditionsContext(task) {
  const root = task?.workspace?.rootHandle;
  if (!root || !task?.handle) throw new Error("Загрузите задание из базового каталога на вкладке «Задания».");
  const parts = await root.resolve(task.handle);
  if (!parts?.length || parts.some(part => !part || /[\\/:*?"<>|\x00-\x1f]/.test(part) || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new Error("Загруженное задание находится вне базового каталога или имеет недопустимый путь.");
  }
  let binding;
  try { binding = await readJson(root, WORKSPACE); }
  catch (error) { if (!missing(error)) throw error; }
  if (binding?.schemaVersion !== 1 || binding.bindingState !== "bound" || !GUID.test(binding.workspaceId ?? "") || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(binding.workspaceId)) {
    throw new Error("Откройте этот базовый каталог в Editor и выполните «Связать с Решателем».");
  }
  if (binding.conditionsVersion !== 1) {
    throw new Error("Обновите локальный комплект Clark и повторите «Связать с Решателем» в Editor: требуется поддержка формирования условий расчета.");
  }
  let exists = false;
  try { const output = await task.handle.getDirectoryHandle("output3XX"); await output.getFileHandle("conditions.json"); exists = true; }
  catch (error) { if (!missing(error)) throw error; }
  return { root, workspaceId: binding.workspaceId.toLowerCase(), taskPath: parts.join("/"), exists };
}

export async function prepareConditionsRequest(task, mpiRanks, replace, { signal } = {}) {
  // Keep the permission request within the user gesture; no hardware is read here.
  const root = task?.workspace?.rootHandle;
  const permission = root?.requestPermission?.({ mode: "readwrite" });
  if (!permission || await permission !== "granted") throw new Error("Разрешите запись в базовый каталог задания.");
  signal?.throwIfAborted();
  const count = parseConditionsMpiRanks(mpiRanks);
  const context = await readConditionsContext(task);
  if (context.exists && !replace) throw new Error("conditions.json уже существует. Отметьте разрешение замены файла.");
  const requestId = crypto.randomUUID();
  const request = { schemaVersion: 1, workspaceId: context.workspaceId, requestId, taskPath: context.taskPath, mpiRanks: count, replace: replace === true };
  signal?.throwIfAborted();
  const file = await context.root.getFileHandle(REQUEST, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(JSON.stringify(request, null, 2) + "\n");
    signal?.throwIfAborted();
    await writer.close();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
  return { ...context, requestId, uri: `clark://conditions?workspace=${context.workspaceId}&request=${requestId}` };
}

export async function readConditionsResult(request) {
  let result;
  try { result = await readJson(request.root, RESULT); }
  catch (error) { if (missing(error) || error instanceof SyntaxError) return null; throw error; }
  if (result.schemaVersion !== 1 || result.workspaceId !== request.workspaceId || result.requestId !== request.requestId) return null;
  if (result.state === "error") throw new Error(result.message || "Не удалось сохранить условия расчета.");
  if (result.state !== "completed" || result.path !== "output3XX/conditions.json") throw new Error("Некорректный ответ локального помощника Clark.");
  return result;
}

export async function waitForConditionsResult(request, { signal, timeoutMs = 60000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await readConditionsResult(request);
    if (result) return result;
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, intervalMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  throw new Error("Нет подтверждения от локального помощника Clark. Проверьте, разрешён ли браузером вызов приложения, и наличие output3XX/conditions.json. Расчёт этой командой не запускается.");
}
