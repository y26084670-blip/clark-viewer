import { sortTaskDirectories } from "./taskLastOpenedService.js";

export const TASK_SELECTION_CHANNEL = "clark.task-selection.v1";
const otherApp = app => app === "editor" ? "viewer" : "editor";
const appName = app => app === "editor" ? "Editor" : "Viewer";
const validName = name => typeof name === "string" && name.length > 0
  && name !== "." && name !== ".." && !/[\\/\0]/u.test(name);

// Read through the receiving page's own handle. No permission prompts or writes.
export async function readTaskSelection(root, request, { isCurrent = () => true } = {}) {
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error("Выбор задания отменён: состояние страницы изменилось.");
  };
  checkCurrent();
  if (!root) throw new Error("В принимающем приложении не выбран базовый каталог. Ограничения браузера требуют ручной выбор базового каталога.");
  if (!request?.baseHandle || !validName(request.projectName) || !validName(request.taskName)) {
    throw new Error("Получена некорректная команда выбора задания.");
  }
  const sameRoot = await root.isSameEntry(request.baseHandle);
  checkCurrent();
  if (!sameRoot) throw new Error("В Editor и Viewer выбраны разные базовые каталоги. Ограничения браузера требуют ручной выбор базового каталога.");
  if (typeof root.queryPermission === "function") {
    const permission = await root.queryPermission({ mode: "read" });
    checkCurrent();
    if (permission !== "granted") throw new Error("Доступ к базовому каталогу утрачен. Повторно выберите каталог.");
  }
  const subdirectories = async handle => {
    const rows = [];
    for await (const [name, entry] of handle.entries()) {
      checkCurrent();
      if (entry.kind === "directory") rows.push({ name, handle: entry });
    }
    checkCurrent();
    return sortTaskDirectories(rows);
  };
  try {
    const projects = await subdirectories(root);
    const project = projects.find(item => item.name === request.projectName);
    if (!project) throw new Error(`Проект «${request.projectName}» отсутствует в базовом каталоге.`);
    const tasks = await subdirectories(project.handle);
    const task = tasks.find(item => item.name === request.taskName);
    if (!task) throw new Error(`Задание «${request.taskName}» отсутствует в проекте «${request.projectName}».`);
    return { projects, project, tasks, task };
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      throw new Error("Нет доступа к каталогам проекта. Повторно выберите базовый каталог.");
    }
    throw error;
  }
}

// Identical in Editor and Viewer; acknowledgements never trigger another request.
export function createTaskSelectionChannel({ app, onSelection,
  BroadcastChannelClass = globalThis.BroadcastChannel, timeoutMs = 15000 } = {}) {
  if (!["editor", "viewer"].includes(app)) throw new Error("Неизвестное приложение.");
  const pending = new Map();
  const instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let counter = 0, channel, disposed = false, receiving = false;
  try { if (BroadcastChannelClass) channel = new BroadcastChannelClass(TASK_SELECTION_CHANNEL); }
  catch { /* A restricted browser context can disallow BroadcastChannel. */ }

  const finish = (requestId, error) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve();
  };
  if (channel) channel.onmessage = async event => {
    const message = event.data;
    if (disposed || message?.version !== 1 || message.target !== app
      || message.source !== otherApp(app) || typeof message.requestId !== "string") return;
    if (message.type === "selection-result") {
      if (typeof message.ok === "boolean") finish(message.requestId,
        message.ok ? null : message.error || "Не удалось выбрать задание.");
      return;
    }
    if (message.type !== "select-task") return;
    let error;
    const alreadyReceiving = receiving;
    try {
      if (alreadyReceiving) throw new Error("Дождитесь завершения предыдущего перехода.");
      receiving = true;
      await onSelection(message);
    } catch (failure) { error = failure?.message || String(failure); }
    finally { if (!alreadyReceiving) receiving = false; }
    if (disposed) return;
    try {
      channel.postMessage({ version: 1, type: "selection-result", source: app,
        target: message.source, requestId: message.requestId, ok: !error, error });
    } catch { /* The sending page may already be closed. */ }
  };
  return {
    supported: Boolean(channel),
    select({ baseHandle, projectName, taskName }) {
      if (disposed) return Promise.reject(new Error("Страница закрыта."));
      if (!channel) return Promise.reject(new Error("Обмен между страницами недоступен в этом браузере."));
      if (!baseHandle || !validName(projectName) || !validName(taskName)) {
        return Promise.reject(new Error("Выберите проект и задание."));
      }
      const requestId = `${instanceId}-${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(requestId,
          `${appName(otherApp(app))} не ответил. Откройте оба приложения с одного сайта в одном браузере и профиле.`), timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          channel.postMessage({ version: 1, type: "select-task", source: app,
            target: otherApp(app), requestId, baseHandle, projectName, taskName });
        } catch (error) { finish(requestId, `Не удалось передать команду: ${error?.message || String(error)}`); }
      });
    },
    dispose() {
      disposed = true;
      for (const requestId of pending.keys()) finish(requestId, "Страница закрыта.");
      channel?.close();
    },
  };
}
