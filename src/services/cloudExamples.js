// Published by Editor. Both applications interpret this index identically.
const key = value => value.normalize("NFC").toLowerCase();
const readOnly = () => new DOMException("Облачный пример доступен только для чтения.", "NotAllowedError");

export function catalogDisplayName(handle) {
  return handle.name + (handle.cloud ? "_cloud" : "");
}

export function checkExampleName(name) {
  if (typeof name !== "string" || !name || name.length > 255 || name === "." || name === ".."
      || /[<>:"/\\|?*\u0000-\u001f\u007f]|[. ]$/u.test(name)
      || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error("Недопустимое имя файла или каталога: «" + name + "».");
  }
  return name;
}

const parents = new WeakMap();

class CloudDirectory {
  kind = "directory";
  cloud = true;
  children = new Map();
  constructor(name) { this.name = name; }
  async *entries() { for (const child of this.children.values()) yield [child.name, child]; }
  async *values() { yield* this.children.values(); }
  [Symbol.asyncIterator]() { return this.entries(); }
  async isSameEntry(other) { return this === other; }
  async resolve(entry) {
    const segments = [];
    for (let current = entry; current; current = parents.get(current)) {
      if (current === this) return segments.reverse();
      segments.push(current.name);
    }
    return null;
  }
  async queryPermission({ mode } = {}) { return mode === "readwrite" ? "denied" : "granted"; }
  child(name, kind, options) {
    if (options?.create) throw readOnly();
    const child = this.children.get(key(name));
    if (!child) throw new DOMException(name, "NotFoundError");
    if (child.kind !== kind) throw new DOMException(name, "TypeMismatchError");
    return child;
  }
  async getDirectoryHandle(name, options) { return this.child(name, "directory", options); }
  async getFileHandle(name, options) { return this.child(name, "file", options); }
  async removeEntry() { throw readOnly(); }
}

class CloudFile {
  kind = "file";
  cloud = true;
  constructor(name, url, size, fetchImpl) { Object.assign(this, { name, url, size, fetchImpl }); }
  async response(signal) {
    const fetchFile = this.fetchImpl;
    const response = await fetchFile(this.url, { signal, credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("Не удалось скачать «" + this.name + "» (HTTP " + response.status + ").");
    return response;
  }
  verify(size) {
    if (size !== this.size) throw new Error("Размер «" + this.name + "» отличается от указанного в индексе.");
  }
  async getFile() {
    const blob = await (await this.response()).blob();
    this.verify(blob.size);
    return new File([blob], this.name, { type: blob.type });
  }
  async createWritable() { throw readOnly(); }
  async isSameEntry(other) { return this === other; }
}

export function buildCloudCatalogs(manifest, manifestUrl, fetchImpl = globalThis.fetch) {
  if (manifest?.version !== 1 || manifest.baseUrl !== "examples/" || !Array.isArray(manifest.entries)) {
    throw new Error("Некорректный индекс облачных примеров.");
  }
  const base = new URL(manifest.baseUrl, manifestUrl);
  const root = new CloudDirectory("");
  const declared = new Set();
  for (const entry of manifest.entries) {
    const parts = entry.path.split("/").map(checkExampleName);
    const directory = entry.type === "directory";
    if ((!directory && (entry.type !== "file" || !Number.isSafeInteger(entry.size) || entry.size < 0))
        || declared.has(entry.path)) throw new Error("Некорректная запись индекса: " + entry.path);
    declared.add(entry.path);
    let parent = root;
    for (const [i, name] of parts.entries()) {
      const folder = i < parts.length - 1 || directory;
      const id = key(name);
      let node = parent.children.get(id);
      if (node && (node.name !== name || (node.kind === "directory") !== folder)) {
        throw new Error("Совпадающие пути в индексе: " + entry.path);
      }
      if (!node) {
        node = folder ? new CloudDirectory(name)
          : new CloudFile(name, new URL(parts.map(encodeURIComponent).join("/"), base).href, entry.size, fetchImpl);
        parents.set(node, parent);
        parent.children.set(id, node);
      }
      parent = node;
    }
  }
  if (!Array.isArray(manifest.catalogs)) throw new Error("В индексе отсутствует перечень каталогов.");
  const ids = new Set();
  return manifest.catalogs.map(({ directory, name }) => {
    const handle = root.children.get(key(checkExampleName(directory)));
    if (handle?.kind !== "directory" || handle.name !== directory || name !== directory + "_cloud" || ids.has(directory)) {
      throw new Error("Некорректный облачный каталог: " + directory);
    }
    ids.add(directory);
    return { name, id: "cloud:" + directory, handle };
  });
}

export async function loadCloudCatalogs(app, { signal } = {}) {
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const relative = app === "viewer" ? "../clark-editor/cloud-examples.json" : "cloud-examples.json";
  const standalone = app === "viewer" && base.pathname === "/";
  const defaultUrl = standalone ? "https://y26084670-blip.github.io/clark-editor/cloud-examples.json" : relative;
  const url = new URL(import.meta.env.VITE_CLARK_EXAMPLES_URL || defaultUrl, base);
  const response = await fetch(url, { cache: "no-cache", credentials: "omit", redirect: "error", signal });
  if (!response.ok) throw new Error("Не удалось прочитать облачный каталог (HTTP " + response.status + ").");
  return buildCloudCatalogs(await response.json(), url);
}

async function readLocalJson(catalog, name) {
  if (!catalog || catalog.cloud) return null;
  try {
    const file = await (await catalog.getFileHandle(name)).getFile();
    return JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
  } catch { return null; }
}

export async function readZoneReport(catalog) {
  const report = await readLocalJson(catalog, "clark.file-zones.json");
  return {
    request: report?.requestId,
    blocked: new Set(report?.version === 1 && Array.isArray(report.blocked) ? report.blocked.map(key) : []),
    unknown: new Set(report?.version === 1 && Array.isArray(report.unknown) ? report.unknown.map(key) : []),
  };
}

export async function zoneWorkspace(catalog) {
  const marker = await readLocalJson(catalog, "clark.workspace.json");
  return marker?.bindingState === "bound" && marker.fileZonesVersion === 1
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(marker.workspaceId) ? marker.workspaceId : "";
}
