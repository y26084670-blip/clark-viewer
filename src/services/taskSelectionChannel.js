import { listProjectCatalogs } from "./projectDiskAccessService.js";
import { sortTaskDirectories } from "./taskLastOpenedService.js";

export const TASK_SELECTION_CHANNEL = "clark.task-selection.v2";
const otherApp = app => app === "editor" ? "viewer" : "editor";
const appName = app => app === "editor" ? "Editor" : "Viewer";
const validName = name => typeof name === "string" && name.length > 0
  && name !== "." && name !== ".." && !/[\\/\0]/u.test(name);

// An explicit user command can carry an already granted disk handle.
// Resolve exact entry identity; never prompt for permission or write files.
export async function readTaskSelection(root, request, { catalogs = [], diskHandle = null, isCurrent = () => true } = {}) {
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error("Выбор задания отменён: состояние страницы изменилось.");
  };
  checkCurrent();
  if (!request?.baseHandle || !validName(request.projectName) || !validName(request.taskName)) {
    throw new Error("Получена некорректная команда выбора задания.");
  }
  const findRoot = async handles => {
    for (const handle of handles.filter(Boolean)) {
      const same = await handle.isSameEntry(request.baseHandle);
      checkCurrent();
      if (same) return handle;
    }
    return null;
  };
  let selectedRoot = await findRoot([root, ...catalogs.map(item => item.handle)]);
  let selectedDisk = diskHandle, selectedCatalogs = catalogs;
  if (!selectedRoot) {
    // Refresh stale lists first, then resolve the sender's explicit disk. A
    // different selected disk must not make Editor -> Viewer asymmetric.
    for (const disk of [...new Set([diskHandle, request.diskHandle].filter(Boolean))]) {
      if (disk.kind !== "directory" || typeof disk.entries !== "function") continue;
      try {
        const permission = typeof disk.queryPermission === "function"
          ? await disk.queryPermission({ mode: "read" }) : "granted";
        checkCurrent();
        if (permission !== "granted") continue;
        const fresh = await listProjectCatalogs(disk);
        checkCurrent();
        selectedRoot = await findRoot(fresh.map(item => item.handle));
        if (selectedRoot) { selectedDisk = disk; selectedCatalogs = fresh; break; }
      } catch (error) {
        checkCurrent();
        if (!["NotAllowedError", "SecurityError", "NotFoundError"].includes(error?.name)) throw error;
      }
    }
  }
  checkCurrent();
  if (!selectedRoot) {
    if (!root && !catalogs.length) throw new Error("В принимающем приложении не выбран диск с проектами. Разрешите доступ к диску.");
    throw new Error("В Editor и Viewer выбраны разные базовые каталоги, а нужный каталог недоступен на выбранном диске. Выберите диск с этим каталогом.");
  }
  root = selectedRoot;
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
    return { root, diskHandle: selectedDisk, catalogs: selectedCatalogs, projects, project, tasks, task };
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      throw new Error("Нет доступа к каталогам проекта. Повторно выберите базовый каталог.");
    }
    throw error;
  }
}

// Identical in Editor and Viewer. Discovery never applies a selection; only the
// addressed instance can execute it. v1 tabs must be refreshed before joining.
export function createTaskSelectionChannel({ app, onSelection,
  BroadcastChannelClass = globalThis.BroadcastChannel, timeoutMs = 15000,
  discoveryMs = 100, getActivity,
  focusWindow = () => globalThis.window?.focus() } = {}) {
  if (!["editor", "viewer"].includes(app)) throw new Error("Неизвестное приложение.");
  const pending = new Map();
  const instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const browser = globalThis.window, document = globalThis.document;
  let lastActiveAt = document?.visibilityState === "visible" ? Date.now() : 0;
  let counter = 0, channel, disposed = false, receiving = false;
  try { if (BroadcastChannelClass) channel = new BroadcastChannelClass(TASK_SELECTION_CHANNEL); }
  catch { /* A restricted browser context can disallow BroadcastChannel. */ }

  const markActive = () => { lastActiveAt = Date.now(); };
  const markVisible = () => { if (document.visibilityState === "visible") markActive(); };
  if (channel) {
    browser?.addEventListener("focus", markActive);
    browser?.addEventListener("pointerdown", markActive, true);
    document?.addEventListener("visibilitychange", markVisible);
  }
  const send = (type, requestId, fields = {}) => channel.postMessage({
    version: 2, type, source: app, target: otherApp(app), requestId,
    sourceInstanceId: instanceId, ...fields,
  });
  const finish = (requestId, error) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    clearTimeout(entry.discoveryTimer);
    if (error) entry.reject(new Error(error));
    else entry.resolve();
  };
  const dispatch = requestId => {
    const entry = pending.get(requestId);
    if (!entry || entry.active) return;
    entry.discovering = false;
    const next = [...entry.offers.values()].filter(offer => !entry.tried.has(offer.sourceInstanceId))
      .sort((a, b) => Number(b.available) - Number(a.available)
        || Number(b.focused) - Number(a.focused) || b.lastActiveAt - a.lastActiveAt
        || a.sourceInstanceId.localeCompare(b.sourceInstanceId))[0];
    if (!next) {
      if (entry.errors.length) finish(requestId, entry.errors[0]);
      return; // No peer yet: accept late discovery replies until the deadline.
    }
    entry.active = next.sourceInstanceId;
    entry.tried.add(entry.active);
    try { send("select-task", requestId, { ...entry.selection, targetInstanceId: entry.active }); }
    catch (error) { finish(requestId, `Не удалось передать команду: ${error?.message || String(error)}`); }
  };
  if (channel) channel.onmessage = async event => {
    const message = event.data;
    if (disposed || message?.version !== 2 || message.target !== app
      || message.source !== otherApp(app) || typeof message.requestId !== "string"
      || typeof message.sourceInstanceId !== "string" || !message.sourceInstanceId) return;
    if (message.type === "find-receiver") {
      const activity = getActivity?.() ?? { focused: document?.hasFocus?.(), lastActiveAt };
      try {
        send("receiver-offer", message.requestId, { targetInstanceId: message.sourceInstanceId,
          available: !receiving, focused: Boolean(activity.focused),
          lastActiveAt: Number.isFinite(activity.lastActiveAt) ? activity.lastActiveAt : 0 });
      } catch { /* The requesting page may already be closed. */ }
      return;
    }
    if (message.targetInstanceId !== instanceId) return;
    const entry = pending.get(message.requestId);
    if (message.type === "receiver-offer") {
      if (!entry || typeof message.available !== "boolean" || typeof message.focused !== "boolean"
        || !Number.isFinite(message.lastActiveAt)) return;
      entry.offers.set(message.sourceInstanceId, message);
      if (!entry.discovering) dispatch(message.requestId);
      return;
    }
    if (message.type === "selection-result") {
      if (!entry || message.sourceInstanceId !== entry.active || typeof message.ok !== "boolean") return;
      if (message.ok) finish(message.requestId);
      else {
        entry.errors.push(typeof message.error === "string" && message.error ? message.error : "Не удалось выбрать задание.");
        entry.active = null;
        dispatch(message.requestId);
      }
      return;
    }
    if (message.type !== "select-task") return;
    let error;
    const alreadyReceiving = receiving;
    try {
      if (alreadyReceiving) throw new Error("Дождитесь завершения предыдущего перехода.");
      receiving = true;
      await onSelection(message);
      // Best effort: browser policy may keep an independently opened tab behind.
      // Selection has succeeded even if raising the tab is blocked.
      if (!disposed) { try { focusWindow(); } catch { /* Keep the successful selection. */ } }
    } catch (failure) { error = failure?.message || String(failure); }
    finally { if (!alreadyReceiving) receiving = false; }
    if (disposed) return;
    try {
      send("selection-result", message.requestId, { targetInstanceId: message.sourceInstanceId, ok: !error, error });
    } catch { /* The sending page may already be closed. */ }
  };
  return {
    supported: Boolean(channel),
    select({ baseHandle, diskHandle, projectName, taskName }) {
      if (disposed) return Promise.reject(new Error("Страница закрыта."));
      if (!channel) return Promise.reject(new Error("Обмен между страницами недоступен в этом браузере."));
      if (!baseHandle || !validName(projectName) || !validName(taskName)) {
        return Promise.reject(new Error("Выберите проект и задание."));
      }
      const requestId = `${instanceId}-${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(requestId,
          `${appName(otherApp(app))} не ответил. Обновите Editor и Viewer (F5) и откройте их с одного сайта в одном браузере и профиле.`), timeoutMs);
        const discoveryTimer = setTimeout(() => dispatch(requestId), discoveryMs);
        pending.set(requestId, { resolve, reject, timer, discoveryTimer, discovering: true,
          offers: new Map(), tried: new Set(), errors: [], active: null,
          selection: { baseHandle, diskHandle, projectName, taskName } });
        try {
          send("find-receiver", requestId);
        } catch (error) { finish(requestId, `Не удалось передать команду: ${error?.message || String(error)}`); }
      });
    },
    dispose() {
      disposed = true;
      for (const requestId of pending.keys()) finish(requestId, "Страница закрыта.");
      channel?.close();
      browser?.removeEventListener("focus", markActive);
      browser?.removeEventListener("pointerdown", markActive, true);
      document?.removeEventListener("visibilitychange", markVisible);
    },
  };
}
