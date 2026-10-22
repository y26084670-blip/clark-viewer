export const NEWS_CACHE_KEY = "clark.updates.cache.v1";
export const NEWS_READ_PREFIX = "clark.updates.read.v1:";
const BASELINE_KEY = "clark.updates.baseline.v1";
const CHANGE_EVENT = "clark-updates-changed";
const VERSION_KEY = "clark.updates.installed.v1";
const GUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const NEWS_CATEGORIES = Object.freeze({ interface: "Интерфейс", computation: "Алгоритмы и вычисления" });

export function validVersion(value) {
  return typeof value === "string" && value.length <= 64 && /^\d+\.\d+\.\d+$/.test(value);
}
export function compareVersions(installed, recommended) {
  if (!validVersion(installed) || !validVersion(recommended)) return null;
  const left = installed.split(".").map(BigInt), right = recommended.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function safeUpdateUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { const url = new URL(value, base); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
export function updatesFeedUrl(app, baseUrl, locationHref) {
  const base = new URL(baseUrl, locationHref);
  return new URL(app === "viewer" ? "../clark-editor/updates.json" : "updates.json", base).href;
}
export function validateUpdatesFeed(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 5000) {
    throw new Error("Некорректный журнал обновлений.");
  }
  const ids = new Set();
  for (const item of value.entries) {
    if (!item || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(item.id)
      || ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !Object.hasOwn(NEWS_CATEGORIES, item.category) || typeof item.release !== "string" || !item.release
      || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date))
      || typeof item.title !== "string" || !item.title.trim() || typeof item.summary !== "string") {
      throw new Error("Некорректная запись журнала обновлений.");
    }
    ids.add(item.id);
    for (const key of ["action", "limitations", "detailsUrl"]) {
      if (item[key] !== undefined && typeof item[key] !== "string") throw new Error("Некорректная запись журнала обновлений.");
    }
  }
  if (value.recommendedClark !== null && (!value.recommendedClark || !validVersion(value.recommendedClark.version)
    || !safeUpdateUrl(value.recommendedClark.installerUrl))) throw new Error("Некорректная рекомендуемая версия Clark.");
  return { ...value, entries: [...value.entries].sort((a, b) => b.date.localeCompare(a.date)) };
}

// A separate key for each read acknowledgement prevents simultaneous tabs from
// overwriting one another. Notification identity is independent of package versions.
export function createChangeNotifications({ storage, eventTarget, fetchImpl = globalThis.fetch,
  url, onChange = () => {}, now = Date.now, timeoutMs = 10000 } = {}) {
  const memory = new Map();
  let persistent = Boolean(storage), disposed = false, pending = null, abort;
  let state = { feed: null, checkedAt: null, source: "none", loading: false, error: "", persistent };
  const read = key => {
    try { return persistent ? storage.getItem(key) : memory.get(key) ?? null; }
    catch { persistent = false; return memory.get(key) ?? null; }
  };
  const write = (key, value) => {
    memory.set(key, value);
    try { if (persistent) storage.setItem(key, value); } catch { persistent = false; }
  };
  const token = item => NEWS_READ_PREFIX + item.id + ":" + item.revision;
  const isRead = item => read(token(item)) === "1";
  const emit = () => { if (!disposed) { state = { ...state, persistent }; onChange({ ...state }); } };
  const notify = () => { emit(); eventTarget?.dispatchEvent(new Event(CHANGE_EVENT)); };
  function initialize(feed) {
    if (read(BASELINE_KEY)) return;
    for (const category of Object.keys(NEWS_CATEGORIES)) {
      const items = feed.entries.filter(item => item.category === category), latest = items[0]?.release;
      for (const item of items) if (item.release !== latest) write(token(item), "1");
    }
    write(BASELINE_KEY, "1");
  }
  try {
    const cached = JSON.parse(read(NEWS_CACHE_KEY) || "null");
    if (cached) {
      const feed = validateUpdatesFeed(cached.feed);
      state = { ...state, feed, checkedAt: cached.checkedAt, source: "cache" };
      initialize(feed);
    }
  } catch { /* A corrupt cache never prevents opening either application. */ }
  const externalChange = event => {
    if (event.type === "storage" && event.key && !event.key.startsWith(NEWS_READ_PREFIX)
      && ![NEWS_CACHE_KEY, BASELINE_KEY].includes(event.key)) return;
    if (event.type === "storage" && event.key === NEWS_CACHE_KEY) {
      try {
        const cached = JSON.parse(read(NEWS_CACHE_KEY));
        const feed = validateUpdatesFeed(cached.feed);
        state = { ...state, feed, checkedAt: cached.checkedAt, source: "cache", error: "" };
      } catch { /* Keep the previous valid journal. */ }
    }
    emit();
  };
  eventTarget?.addEventListener("storage", externalChange);
  eventTarget?.addEventListener(CHANGE_EVENT, externalChange);
  return {
    snapshot: () => ({ ...state, persistent }), isRead,
    unread(category) { return state.feed?.entries.filter(item => (!category || item.category === category) && !isRead(item)).length ?? 0; },
    markRead(items) { for (const item of items) write(token(item), "1"); notify(); },
    refresh() {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      state = { ...state, loading: true, error: "" }; emit();
      pending = Promise.resolve().then(async () => {
        if (disposed) { clearTimeout(timer); return; }
        try {
          const response = await fetchImpl(url, { cache: "no-store", signal: abort.signal });
          if (!response.ok) throw new Error("HTTP " + response.status);
          const feed = validateUpdatesFeed(await response.json());
          if (disposed) return;
          initialize(feed);
          const checkedAt = new Date(now()).toISOString();
          write(NEWS_CACHE_KEY, JSON.stringify({ feed, checkedAt }));
          state = { ...state, feed, checkedAt, source: "network" };
        } catch {
          if (!disposed) state = { ...state, source: state.feed ? "cache" : "none",
            error: state.feed ? "Журнал недоступен. Показана последняя сохранённая копия." : "Не удалось загрузить журнал обновлений." };
        } finally { clearTimeout(timer); pending = null; state = { ...state, loading: false }; emit(); }
      });
      return pending;
    },
    dispose() {
      disposed = true; abort?.abort();
      eventTarget?.removeEventListener("storage", externalChange);
      eventTarget?.removeEventListener(CHANGE_EVENT, externalChange);
    },
  };
}

export function installedVersionSnapshot(data) {
  if (!validVersion(data?.appVersion) || !Number.isFinite(Date.parse(data.appVersionCheckedAt))) return null;
  return { version: data.appVersion, checkedAt: data.appVersionCheckedAt };
}
export function readSavedInstalledVersion(storage) {
  try {
    const data = JSON.parse(storage?.getItem(VERSION_KEY) || "null");
    return validVersion(data?.version) && Number.isFinite(Date.parse(data.checkedAt)) ? data : null;
  } catch { return null; }
}
export function saveInstalledVersion(storage, value) {
  try {
    if (value) storage?.setItem(VERSION_KEY, JSON.stringify(value));
    else storage?.removeItem(VERSION_KEY);
  } catch { /* Version checks still work when browser storage is disabled. */ }
}
async function readJson(root, name) {
  return JSON.parse((await (await (await root.getFileHandle(name)).getFile()).text()).replace(/^\uFEFF/, ""));
}
export async function findVersionContext(catalogs) {
  const contexts = [];
  for (const { handle: root } of catalogs) {
    try {
      const binding = await readJson(root, "clark.workspace.json");
      if (binding.schemaVersion === 1 && binding.bindingState === "bound" && GUID.test(binding.workspaceId ?? "")) {
        contexts.push({ root, binding, installed: installedVersionSnapshot(binding) });
      }
    } catch { /* Other catalogs may be unbound or inaccessible. */ }
  }
  return contexts.sort((a, b) => (Date.parse(b.installed?.checkedAt) || 0) - (Date.parse(a.installed?.checkedAt) || 0))[0] ?? null;
}
export function createVersionCheckRequest(context) {
  if (!context || context.binding.launchOptionsVersion !== 1) return null;
  const requestId = crypto.randomUUID(), workspaceId = context.binding.workspaceId;
  const query = new URLSearchParams({ workspace: workspaceId, request: requestId });
  return { root: context.root, workspaceId, requestId, uri: `clark://settings?${query}` };
}
export async function waitForVersionCheck(request, { signal, timeoutMs = 15000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    try {
      const data = await readJson(request.root, "clark.settings.json");
      if (data.schemaVersion === 1 && data.requestId === request.requestId && data.workspaceId === request.workspaceId) {
        return installedVersionSnapshot(data);
      }
    } catch (error) { if (error.name !== "NotFoundError" && !(error instanceof SyntaxError)) throw error; }
    await new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener("abort", cancel); resolve(); };
      const timer = setTimeout(done, intervalMs);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal.reason); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  throw new Error("Clark не ответил. Разрешите открытие приложения в браузере и повторите проверку.");
}
