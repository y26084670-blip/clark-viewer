import { sortTaskDirectories } from "./taskLastOpenedService.js";

// Этот контракт одинаков в Editor и Viewer; выбранные проекты сюда не входят.
const DATABASE = "clark.project-disk.v1", STORE = "access", KEY = "disk";
const CHANNEL = "clark.project-disk.v1";

export function isProjectCatalog(name) {
  return typeof name === "string" && /^clark\..+/i.test(name) && name.length <= 255
    && name.toLowerCase() !== "clark.app" && !/[\\/<>:"|?*\x00-\x1f]|[. ]$/.test(name);
}

export async function listProjectCatalogs(disk) {
  const catalogs = [];
  // Служебные каталоги только перечисляются: их содержимое не открывается.
  for await (const [name, handle] of disk.entries()) {
    if (handle.kind === "directory" && isProjectCatalog(name)) catalogs.push({ name, handle });
  }
  return sortTaskDirectories(catalogs);
}

function accessStore(mode, operation, browser) {
  return new Promise((resolve, reject) => {
    let database, transaction, settled = false, value;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); database?.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error("Хранилище доступа к диску не отвечает."));
      try { transaction?.abort(); } catch { /* Транзакция уже завершена. */ }
    }, 5000);
    try {
      if (!browser.indexedDB) throw new Error("Хранилище доступа к диску недоступно.");
      const opening = browser.indexedDB.open(DATABASE, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
      };
      opening.onerror = () => finish(opening.error);
      opening.onblocked = () => finish(new Error("Хранилище доступа к диску занято другой вкладкой."));
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database.close();
        try {
          transaction = database.transaction(STORE, mode);
          transaction.oncomplete = () => finish();
          transaction.onabort = () => finish(transaction.error || new Error("Доступ к хранилищу диска прерван."));
          transaction.onerror = () => finish(transaction.error || new Error("Ошибка хранилища доступа к диску."));
          const request = operation(transaction.objectStore(STORE));
          request.onsuccess = () => { value = request.result; };
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}

export async function readProjectDisk(browser = globalThis) {
  const record = await accessStore("readonly", store => store.get(KEY), browser);
  if (record?.version !== 1 || record.handle?.kind !== "directory"
    || typeof record.handle.entries !== "function") return null;
  return record.handle;
}

export async function saveProjectDisk(handle, browser = globalThis) {
  await accessStore("readwrite", store => store.put({ version: 1, handle }, KEY), browser);
  let channel;
  try {
    channel = new browser.BroadcastChannel(CHANNEL);
    channel.postMessage({ version: 1, type: "changed" });
  } catch { /* Сохранённый диск по-прежнему доступен при открытии/фокусе вкладки. */ }
  finally { channel?.close(); }
}

export function watchProjectDisk(onChange, browser = globalThis) {
  let channel;
  try {
    channel = new browser.BroadcastChannel(CHANNEL);
    channel.onmessage = event => {
      if (event.data?.version === 1 && event.data.type === "changed") onChange();
    };
  } catch { /* Уведомления необязательны; доступ сохраняется в IndexedDB. */ }
  return () => channel?.close();
}

export function projectDiskPermission(handle, { request = false } = {}) {
  // requestPermission вызывается непосредственно из пользовательского щелчка.
  const method = request ? "requestPermission" : "queryPermission";
  return typeof handle?.[method] === "function"
    ? handle[method]({ mode: "readwrite" }) : Promise.resolve("prompt");
}
