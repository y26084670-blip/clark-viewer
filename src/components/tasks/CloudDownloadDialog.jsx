import { For, Show, createEffect, createSignal, createUniqueId, onMount, onCleanup } from "solid-js";
import { availableName, checkExampleName, copyCloudTask, loadCloudCatalogs, readZoneReport, zoneWorkspace } from "../../services/cloudExamples.js";
import { isProjectCatalog, listProjectCatalogs } from "../../services/projectDiskAccessService.js";
import "./CloudDownloadDialog.css";

export function useCloudCatalogs(app, root) {
  const [catalogs, setCatalogs] = createSignal([]);
  const [error, setError] = createSignal("");
  const [zones, setZones] = createSignal(new Set());
  const controller = new AbortController();
  let zoneRevision = 0, zonePoll = 0, workspace = "";
  function stopPolling() { clearInterval(zonePoll); zonePoll = 0; }
  async function refreshZones() {
    const handle = root(), revision = ++zoneRevision;
    const [report, bound] = await Promise.all([readZoneReport(handle), zoneWorkspace(handle)]);
    if (!controller.signal.aborted && revision === zoneRevision && handle === root()) {
      setZones(report.blocked); workspace = bound;
    }
    return report.request;
  }
  function checkZones() {
    if (!workspace || root()?.cloud) return;
    const request = crypto.randomUUID();
    window.location.href = "clark://zones?" + new URLSearchParams({ workspace, request });
    stopPolling();
    const until = Date.now() + 120000;
    zonePoll = window.setInterval(async () => {
      if (await refreshZones() === request || Date.now() > until) stopPolling();
    }, 1000);
  }
  async function refresh() {
    try {
      setError("");
      const entries = await loadCloudCatalogs(app, { signal: controller.signal });
      if (!controller.signal.aborted) setCatalogs(entries);
    } catch (e) { if (!controller.signal.aborted) setError("Облачные примеры недоступны. " + e.message); }
  }
  createEffect(() => { root(); workspace = ""; stopPolling(); setZones(new Set()); void refreshZones(); });
  onMount(() => { void refresh(); window.addEventListener("focus", refreshZones); });
  onCleanup(() => { controller.abort(); stopPolling(); window.removeEventListener("focus", refreshZones); });
  return { catalogs, error, refresh, refreshZones, checkZones,
    value: () => root()?.cloud ? "cloud:" + root().name : root()?.name ?? "",
    blocked: (project, task) => !root()?.cloud && zones().has((project + "/" + task).normalize("NFC").toLowerCase()),
  };
}

export function CloudDownloadDialog(props) {
  const id = createUniqueId();
  const [disk, setDisk] = createSignal(props.disk);
  const [catalogs, setCatalogs] = createSignal(props.catalogs || []);
  const [catalog, setCatalog] = createSignal("");
  const [projects, setProjects] = createSignal([]);
  const [project, setProject] = createSignal(props.project);
  const [name, setName] = createSignal(props.task.name);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [file, setFile] = createSignal("");
  const [copied, setCopied] = createSignal(null);
  let dialog, revision = 0, controller = new AbortController();

  async function chooseCatalog(value) {
    const request = ++revision;
    setCatalog(value); setProjects([]);
    const handle = catalogs().find(item => item.name === value)?.handle;
    if (!handle) return;
    const names = [];
    try {
      for await (const [name, child] of handle.entries()) if (child.kind === "directory") names.push(name);
      if (request === revision) setProjects(names.sort((a,b) => a.localeCompare(b, "ru")));
    } catch (error) { if (request === revision) setMessage(error.message); }
  }
  function defaultCatalog(entries) {
    return entries.find(item => item.name === "clark.projects")?.name ?? entries[0]?.name ?? "clark.projects";
  }
  onMount(() => { dialog.showModal(); void chooseCatalog(defaultCatalog(catalogs())); });
  onCleanup(() => { revision++; controller.abort(); dialog?.close(); });
  async function pick() {
    if (!window.showDirectoryPicker) { setMessage("Для записи выберите Chrome или Edge и откройте приложение по HTTPS или localhost."); return; }
    setBusy(true); setMessage("");
    try {
      const handle = await window.showDirectoryPicker({ id: "clark-project-disk", mode: "readwrite" });
      const entries = await listProjectCatalogs(handle);
      setDisk(handle); setCatalogs(entries);
      await chooseCatalog(defaultCatalog(entries));
    } catch (error) { if (error.name !== "AbortError") setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (busy() || !disk()) return;
    setBusy(true); setMessage("");
    try {
      let result = copied();
      if (!result) {
        if (!isProjectCatalog(catalog())) throw new Error("Укажите локальный каталог clark.* с проектами.");
        checkExampleName(catalog()); checkExampleName(project()); checkExampleName(name());
        const root = await disk().getDirectoryHandle(catalog(), { create: true });
        const parent = await root.getDirectoryHandle(project(), { create: true });
        const free = await availableName(parent, name());
        if (free !== name()) { setName(free); setMessage("Имя занято. Проверьте предложенное имя и нажмите «Применить»."); return; }
        const handle = await copyCloudTask(props.task.handle, parent, name(), { signal: controller.signal, onFile: setFile });
        result = { disk: disk(), root, parent, handle };
        setCopied(result);
      }
      result.catalogs = await listProjectCatalogs(result.disk);
      await props.onDone(result);
      props.onClose();
    } catch (error) {
      if (error.suggestedName) setName(error.suggestedName);
      setMessage((copied() ? "Задание уже скопировано. " : "") + error.message);
    } finally { setBusy(false); setFile(""); }
  }
  return <dialog class="cloud-download-dialog" ref={dialog} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy()) props.onClose(); }}>
    <h2 id={id}>Локальная загрузка выделенного облачного проекта</h2>
    <div class="cloud-download-disk"><button type="button" disabled={busy() || copied()} onClick={pick}>Выбрать диск</button>
      <span>{disk()?.name || "Диск не выбран"}</span></div>
    <label>Локальный каталог с проектами<input list={id + "-catalogs"} value={catalog()} disabled={!disk() || busy() || copied()}
      onInput={event => void chooseCatalog(event.currentTarget.value)} /></label>
    <datalist id={id + "-catalogs"}><For each={catalogs()}>{item => <option value={item.name} />}</For></datalist>
    <label>Проект<input list={id + "-projects"} value={project()} disabled={!disk() || busy() || copied()}
      onInput={event => setProject(event.currentTarget.value)} /></label>
    <datalist id={id + "-projects"}><For each={projects()}>{value => <option value={value} />}</For></datalist>
    <label>Имя задания<input value={name()} disabled={busy() || copied()} onInput={event => setName(event.currentTarget.value)} /></label>
    <Show when={file() || message()}><p role="status">{message() || file()}</p></Show>
    <footer><button type="button" disabled={!disk() || busy()} onClick={apply}>Применить</button>
      <button type="button" disabled={busy()} onClick={props.onClose}>Закрыть</button></footer>
  </dialog>;
}
