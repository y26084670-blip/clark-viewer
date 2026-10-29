import { readTaskDirectoryLists } from "../services/taskDirectoryRefresh.js";
import { batch, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createLastOpenedTaskHistory, sortTaskDirectories } from "../services/taskLastOpenedService.js";
import { listProjectCatalogs, readProjectDisk, saveProjectDisk, watchProjectDisk, projectDiskPermission } from "../services/projectDiskAccessService.js";
import { createTaskSelectionChannel, readTaskSelection } from "../services/taskSelectionChannel.js";
import { loadTaskInput, readTaskSummaries } from "../services/taskLoadService.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { buildGeometryScene } from "../services/visualization/geometrySceneModel.js";
import { ThreeGeometryViewport } from "../components/geometry/ThreeGeometryViewport.jsx";
import { TaskMediaPanel } from "../components/tasks/TaskMediaPanel.jsx";
import { TaskStatusCells } from "../components/tasks/TaskStatusCells.jsx";
import { ProjectDiskDialog } from "../components/tasks/ProjectDiskDialog.jsx";
import { LastOpenedTaskMarker, ProjectSelectValue } from "../components/tasks/LastOpenedTaskMarker.jsx";
import { useTaskStatuses } from "../services/taskStatusMonitor.js";
import { createTaskTestProtocolWindow } from "../services/taskTestProtocolWindow.js";
import { TaskProtocolDownload, useTaskProtocolDownloads } from "../components/tasks/TaskProtocolDownload.jsx";
import "../components/geometry/ResultsGeometryViewport.css";

export function Tasks(props) {
  const [disk, setDisk] = createSignal(null), [catalogs, setCatalogs] = createSignal([]);
  const [pendingDisk, setPendingDisk] = createSignal(null), [accessBusy, setAccessBusy] = createSignal(false);
  const [accessNotice, setAccessNotice] = createSignal("");
  const [accessOpen, setAccessOpen] = createSignal(true);
  const [diskPicked, setDiskPicked] = createSignal(false);
  const [projectListBusy, setProjectListBusy] = createSignal(false);
  const [taskListBusy, setTaskListBusy] = createSignal(false);
  const [projectBrowseNotice, setProjectBrowseNotice] = createSignal("");
  let catalogSelect;
  const [root, setRoot] = createSignal(null), [projects, setProjects] = createSignal([]);
  const [project, setProject] = createSignal(""), [tasks, setTasks] = createSignal([]);
  const protocolDownloads = useTaskProtocolDownloads(tasks, () => props.docsRevision);
  const taskStatus = useTaskStatuses(
    () => tasks().map(item => ({ key: item.handle, handle: item.handle })),
  );
  const [candidate, setCandidate] = createSignal(null), [error, setError] = createSignal("");
  const [galleryBusy, setGalleryBusy] = createSignal(false);
  const [protocolBusy, setProtocolBusy] = createSignal(false);
  const [selectionReceiving, setSelectionReceiving] = createSignal(false);
  const [selectionSending, setSelectionSending] = createSignal(false);
  const [selectionNotice, setSelectionNotice] = createSignal("");
  const [selectionError, setSelectionError] = createSignal("");
  const browserBusy = () => accessBusy() || projectListBusy() || taskListBusy() || galleryBusy() || selectionReceiving() || protocolBusy();
  let taskListElement, selectionErrorDialog, selectionErrorReturnFocus;
  const [lastTask, setLastTask] = createSignal(null), [lastTaskNotice, setLastTaskNotice] = createSignal("");
  const lastTaskHistory = createLastOpenedTaskHistory({ app: "viewer", onChange: setLastTask, onNotice: setLastTaskNotice });
  const lastProjectName = () => projects()[lastTask()?.projectIndex - 1]?.name;
  const isLastTask = item => project() === lastProjectName() && tasks().indexOf(item) + 1 === lastTask()?.taskIndex;
  const protocolWindow = createTaskTestProtocolWindow();
  onCleanup(() => protocolWindow.dispose());
  async function openTestProtocols(item) {
    if (props.busy || browserBusy()) return;
    setError(""); setProtocolBusy(true);
    try { await protocolWindow.open(item.handle, { label: `${project()}/${item.name}` }); }
    catch (error) { if (!disposed && error.name !== "AbortError") setError(error.message); }
    finally { if (!disposed) setProtocolBusy(false); }
  }
  let revision = 0, pickRevision = 0, loadRequest = 0, disposed = false;
  const selectionChannel = createTaskSelectionChannel({ app: "viewer", onSelection: receiveTaskSelection });
  onCleanup(() => selectionChannel.dispose());
  onCleanup(() => { disposed = true; revision++; pickRevision++; loadRequest++; lastTaskHistory.dispose(); });
  onMount(() => {
    const restore = () => { void restoreDisk(); };
    const stopWatching = watchProjectDisk(restore);
    window.addEventListener("focus", restore);
    restore();
    onCleanup(() => { stopWatching(); window.removeEventListener("focus", restore); });
  });
  function showSelectionError(message, returnFocus) {
    selectionErrorReturnFocus = returnFocus;
    setSelectionError(message);
    if (!selectionErrorDialog.open) selectionErrorDialog.showModal();
  }
  async function receiveTaskSelection(request) {
    if (props.busy || browserBusy() || document.querySelector("dialog[open]")) {
      throw new Error("Viewer занят. Завершите текущую операцию и повторите переход.");
    }
    const handle = root(), current = ++revision;
    pickRevision++; loadRequest++;
    setSelectionReceiving(true);
    setSelectionNotice(""); setSelectionError("");
    try {
      const selected = await readTaskSelection(handle, request, {
        catalogs: catalogs(), diskHandle: disk(),
        isCurrent: () => !disposed && handle === root() && current === revision && !props.busy,
      });
      batch(() => {
        if (selected.diskHandle) {
          setDisk(selected.diskHandle); setCatalogs(selected.catalogs);
          setPendingDisk(null); setAccessNotice("");
        }
        setRoot(selected.root);
        setProjects(selected.projects); setProject(selected.project.name);
        setTasks(selected.tasks); setCandidate({ ...selected.task }); setError("");
      });
      if (selected.root !== handle) {
        props.onRootChange?.(selected.root);
        await lastTaskHistory.open(selected.root);
      }
      props.onShowTasks?.();
      setSelectionNotice(`Выбрано задание из Editor: ${selected.root.name}/${selected.project.name}/${selected.task.name}`);
      queueMicrotask(() => {
        if (!disposed && current === revision) {
          const row = taskListElement?.querySelector(".selected");
          row?.scrollIntoView({ block: "nearest" }); row?.focus({ preventScroll: true });
        }
      });
    } finally { setSelectionReceiving(false); }
  }
  async function showInEditor(event) {
    if (!candidate() || props.busy || browserBusy() || selectionSending()) return;
    const sourceButton = event.currentTarget;
    const item = candidate(), name = project(), handle = root();
    setSelectionSending(true); setSelectionNotice(""); setSelectionError("");
    try {
      await selectionChannel.select({ baseHandle: handle, diskHandle: disk(), projectName: name, taskName: item.name });
      if (!disposed) setSelectionNotice(`В Editor выделено задание: ${name}/${item.name}`);
    } catch (error) { if (!disposed) showSelectionError(error.message, sourceButton); }
    finally { if (!disposed) setSelectionSending(false); }
  }
  async function subdirectories(handle) {
    const result = [];
    for await (const [name, item] of handle.entries()) if (item.kind === "directory") result.push({ name, handle: item });
    return sortTaskDirectories(result);
  }
  async function selectCatalog(catalog, isCurrent = () => true) {
    const current = ++revision, picked = catalog?.handle ?? null, previous = root();
    const handle = previous && picked && await previous.isSameEntry(picked) ? previous : picked;
    if (disposed || current !== revision || !isCurrent()) return;
    const entries = handle ? await subdirectories(handle) : [];
    if (disposed || current !== revision || !isCurrent()) return;
    loadRequest++;
    batch(() => {
      setRoot(handle); setProjects(entries); setProject(""); setTasks([]); setCandidate(null); setError("");
    });
    props.onRootChange?.(handle);
    if (handle) await lastTaskHistory.open(handle);
    else { lastTaskHistory.dispose(); setLastTask(null); setLastTaskNotice(""); }
  }
  const accessIsCurrent = request => !disposed && request === pickRevision;
  async function openDisk(handle, request) {
    const entries = await listProjectCatalogs(handle);
    if (!accessIsCurrent(request)) return;
    await selectCatalog(entries.find(item => item.name === root()?.name) ?? entries[0], () => accessIsCurrent(request));
    if (!accessIsCurrent(request)) return;
    batch(() => { setDisk(handle); setCatalogs(entries); setPendingDisk(null); setAccessNotice(""); });
  }
  async function restoreDisk() {
    // Уведомление другого GUI не переключает уже выбранный диск/задание.
    if (disposed || disk() || pendingDisk() || browserBusy() || props.busy) return;
    const request = ++pickRevision;
    try {
      const handle = await readProjectDisk();
      if (!handle || !accessIsCurrent(request)) return;
      const permission = await projectDiskPermission(handle);
      if (!accessIsCurrent(request)) return;
      if (permission !== "granted") { setPendingDisk(handle); return; }
      setAccessBusy(true);
      await openDisk(handle, request);
    } catch {
      if (accessIsCurrent(request)) setAccessNotice("Сохранённый диск недоступен. Выберите диск в окне «Доступ к проектам» после F5.");
    } finally { if (accessIsCurrent(request)) setAccessBusy(false); }
  }
  async function allowDisk() {
    if (props.busy || browserBusy() || !pendingDisk()) return;
    const handle = pendingDisk(), request = ++pickRevision;
    setAccessBusy(true); setAccessNotice("");
    try {
      const permission = await projectDiskPermission(handle, { request: true });
      if (!accessIsCurrent(request)) return;
      if (permission !== "granted") {
        setAccessNotice("Доступ к диску не разрешён. Повторите разрешение или выберите диск в окне «Доступ к проектам» после F5."); return;
      }
      await openDisk(handle, request);
    } catch {
      if (accessIsCurrent(request)) setAccessNotice("Не удалось открыть сохранённый диск. Выберите диск в окне «Доступ к проектам» после F5.");
    } finally { if (accessIsCurrent(request)) setAccessBusy(false); }
  }
  async function pickRoot() {
    if (props.busy || browserBusy() || diskPicked()) return;
    if (!window.isSecureContext || typeof window.showDirectoryPicker !== "function") {
      setError("Выбор каталога недоступен. Откройте приложение по HTTPS или localhost в Chrome либо Edge."); return;
    }
    const request = ++pickRevision;
    setAccessBusy(true); setError("");
    try {
      const handle = await window.showDirectoryPicker({ id: "clark-project-disk", mode: "readwrite" });
      if (!accessIsCurrent(request)) return;
      await openDisk(handle, request);
      if (!accessIsCurrent(request)) return;
      setDiskPicked(true);
      try { await saveProjectDisk(handle); }
      catch { if (accessIsCurrent(request)) setAccessNotice("Диск открыт. Не удалось сохранить доступ; после перезагрузки выберите его снова."); }
    } catch (error) { if (accessIsCurrent(request) && error.name !== "AbortError") setError(error.message); }
    finally { if (accessIsCurrent(request)) setAccessBusy(false); }
  }
  async function changeCatalog(name) {
    if (props.busy || browserBusy()) return;
    pickRevision++; setAccessBusy(true);
    try { await selectCatalog(catalogs().find(item => item.name === name)); }
    catch (error) { if (!disposed) setError("Не удалось открыть каталог: " + error.message); }
    finally { if (!disposed) setAccessBusy(false); }
  }
  async function pickProject(name) {
    if (browserBusy()) return;
    const current = ++revision;
    setProject(name); setTasks([]); setCandidate(null); setError("");
    if (!name) return;
    try {
      const rows = await subdirectories(projects().find(item => item.name === name).handle);
      if (current === revision) setTasks(rows);
    } catch (error) { if (current === revision) setError(error.message); }
  }
  function closeAccess() {
    if (accessBusy()) return;
    setAccessOpen(false);
    queueMicrotask(() => catalogSelect?.focus());
  }
  async function browseProjects() {
    const handle = root();
    if (!handle || props.busy || browserBusy()) return;
    setProjectBrowseNotice("");
    if (!window.isSecureContext || typeof window.showOpenFilePicker !== "function") {
      setProjectBrowseNotice("Просмотр каталога недоступен. Откройте приложение по HTTPS или localhost в Chrome либо Edge."); return;
    }
    try {
      const picked = await window.showOpenFilePicker({ id: "project-catalog-browse", startIn: handle,
        multiple: false, excludeAcceptAllOption: false });
      if (picked?.length && !disposed && handle === root()) setProjectBrowseNotice(
        "Работа с файлами в Проводнике выполняется через контекстное меню при нажатии правой кнопки мыши.");
    } catch (error) {
      if (error.name !== "AbortError" && !disposed && handle === root()) {
        setProjectBrowseNotice("Не удалось просмотреть каталог с проектами: " + error.message);
      }
    }
  }
  async function refreshDirectoryLists(refreshProjects) {
    const handle = root(), name = project();
    if (!handle || props.busy || browserBusy() || (!refreshProjects && !name)) return;
    const current = ++revision;
    loadRequest++;
    const setBusy = refreshProjects ? setProjectListBusy : setTaskListBusy;
    setBusy(true); setError("");
    try {
      const snapshot = await readTaskDirectoryLists({ root: handle, projectName: name, projects: projects(), refreshProjects });
      if (disposed || current !== revision || handle !== root()) return;
      const selected = snapshot.tasks.find(item => item.name === candidate()?.name) ?? null;
      batch(() => {
        setProjects(snapshot.projects); setProject(snapshot.projectName);
        setTasks(snapshot.tasks); setCandidate(selected);
      });
      await taskStatus.refresh();
      if (!disposed && current === revision) await props.onTaskListRefresh?.();
    } catch (error) {
      if (!disposed && current === revision) setError(`Не удалось обновить список ${refreshProjects ? "проектов" : "заданий"}: ${error.message}`);
    } finally { if (!disposed) setBusy(false); }
  }
  const refreshProjects = () => refreshDirectoryLists(true);
  const refreshTasks = () => refreshDirectoryLists(false);
  const info = useAsyncResult(() => candidate(), async item => {
    const [summary, model] = await Promise.allSettled([readTaskSummaries(item.handle), loadTaskInput(item.handle)]);
    return { summary: summary.status === "fulfilled" ? summary.value : { input: summary.reason.message, output: summary.reason.message },
      scene: model.status === "fulfilled" ? buildGeometryScene(model.value) : null,
      error: model.status === "rejected" ? model.reason.message : "" };
  });
  async function load() {
    if (props.busy || browserBusy()) return;
    const item = candidate();
    if (!item) return;
    const request = ++loadRequest;
    const snapshot = lastTaskHistory.capture(projects(), project(), tasks(), item);
    const handle = root();
    try {
      const loaded = await props.onLoad(item.handle, `${handle.name}/${project()}/${item.name}`, { rootHandle: handle });
      if (loaded === true && !disposed && request === loadRequest) await lastTaskHistory.remember(snapshot);
    } catch (error) {
      if (!disposed && request === loadRequest && root() === handle) setError(error.message);
    }
  }
  return <div class="tasks-layout">
    <ProjectDiskDialog open={accessOpen() && props.active !== false} busy={props.busy || accessBusy()}
      picked={diskPicked()} count={catalogs().length} pending={pendingDisk()} notice={accessNotice() || error()}
      onPick={pickRoot} onAllow={allowDisk} onClose={closeAccess} />
    <section class="task-browser-panel">
      <div class="task-browser-content">
        <label class="field-label" for="projectCatalog">Каталоги с проектами</label>
        <div class="task-catalog-row">
          <select id="projectCatalog" ref={catalogSelect} class="project-select" aria-label="Каталоги с проектами"
            value={root()?.name ?? ""} disabled={props.busy || browserBusy() || !catalogs().length}
            onChange={event => changeCatalog(event.currentTarget.value)}>
            <Show when={!catalogs().length}><option value="">{disk() ? "Нет каталогов clark.*" : "Выберите диск с проектами"}</option></Show>
            <For each={catalogs()}>{item => <option value={item.name}>{item.name}</option>}</For>
          </select>
        </div>
        <Show when={pendingDisk() && !accessOpen()}><button type="button" class="folder-button" disabled={props.busy || browserBusy()}
          onClick={allowDisk}>Разрешить доступ к диску «{pendingDisk().name}»</button></Show>
        <Show when={accessNotice() && !accessOpen()}><div class="task-access-notice" role="status">{accessNotice()}</div></Show>
        <div class="root-name">{root() ? `Корневой каталог: ${root().name}` : "Каталог не выбран"}</div>
        <div class="task-list-heading task-project-heading">
          <label class="field-label" for="listProject">Список проектов</label>
          <div class="task-project-actions">
            <button type="button" class="task-project-browse" disabled={!root() || props.busy || browserBusy()}
              aria-label="Просмотр каталога с проектами" title="Просмотр каталога с проектами (выбор не изменяется)" onClick={browseProjects}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3z" fill="none" stroke="currentColor" stroke-width="2" /></svg>
            </button>
            <button type="button" class="task-status-refresh" disabled={!root() || props.busy || browserBusy()}
              aria-label="Обновить список проектов" title="Обновить список проектов" aria-busy={projectListBusy()}
              onClick={refreshProjects}>↻</button>
          </div>
        </div>
        <select id="listProject" class="project-select task-project-select" value={project()} disabled={browserBusy()} onChange={event => pickProject(event.currentTarget.value)} aria-label="Список проектов">
          <ProjectSelectValue value={project()} placeholder="Выберите проект" marked={project() === lastProjectName()} />
          <option value="" selected={!project()}>Выберите проект</option><For each={projects()}>{item => <option value={item.name} selected={item.name === project()}><Show when={item.name === lastProjectName()}><LastOpenedTaskMarker label="Последний открытый проект" /></Show>{item.name}</option>}</For>
        </select>
        <Show when={projectBrowseNotice()}><div class="task-access-notice" role="status">{projectBrowseNotice()}</div></Show>
        <div class="task-list-heading">
          <div class="field-label">Список заданий</div>
          <button type="button" class="task-status-refresh" disabled={!project() || props.busy || browserBusy() || taskStatus.busy()}
            aria-label="Обновить список заданий" aria-busy={taskListBusy() || taskStatus.busy()}
            title="Обновить список заданий" onClick={refreshTasks}>↻</button>
        </div>
        <div class="task-list" ref={taskListElement} role="listbox" aria-label="Список заданий" onClick={event => {
          if (browserBusy()) return;
          const list = event.currentTarget;
          if (event.target !== list) return;
          const bounds = list.getBoundingClientRect();
          const x = event.clientX - bounds.left - list.clientLeft;
          const y = event.clientY - bounds.top - list.clientTop;
          if (x >= 0 && y >= 0 && x < list.clientWidth && y < list.clientHeight) setCandidate(null);
        }}>
          <For each={tasks()}>{item => <div role="option" aria-selected={candidate()?.handle === item.handle}
            aria-disabled={browserBusy()} tabIndex={browserBusy() ? -1 : 0}
            class="task-status-row" classList={{ selected: candidate()?.handle === item.handle }} onClick={() => { if (!browserBusy()) setCandidate({ ...item }); }}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault(); if (!browserBusy()) setCandidate({ ...item });
              }
            }}
            onDblClick={() => { if (candidate()?.handle === item.handle) void load(); }}
            title="Двойной щелчок — загрузить задание для просмотра">
            <TaskStatusCells status={taskStatus(item.handle)} disabled={props.busy || browserBusy()}
              onOpenProtocols={() => { void openTestProtocols(item); }} /><span class="task-status-name">
              <span class="task-status-label"><Show when={isLastTask(item)}><LastOpenedTaskMarker label="Последнее открытое задание" /></Show>{item.name}</span>
              <TaskProtocolDownload taskHandle={item.handle} taskName={item.name} record={protocolDownloads(item.handle)}
                disabled={props.busy || browserBusy()} />
            </span>
          </div>}</For>
        </div>
        <div class="task-load-row">
        <button class="load-button" disabled={!candidate() || props.busy || browserBusy()} onClick={load}>{props.busy ? "Загрузка…" : "Загрузить для просмотра"}</button>
        <button type="button" class="task-cross-open-button"
          disabled={!candidate() || !selectionChannel.supported || props.busy || browserBusy() || selectionSending()}
          aria-busy={selectionSending()}
          title="Выбрать каталог проектов, проект и задание в открытом Editor; браузер может ограничить переключение вкладки"
          onClick={showInEditor}>Выбрать в Editor</button>
        </div>
        <Show when={lastTaskNotice()}><div class="task-last-opened-notice" role="status">{lastTaskNotice()}</div></Show>
        <Show when={error() || props.error || info.value()?.error}><div class="task-error" role="alert">{error() || props.error || info.value()?.error}</div></Show>
      </div>
      <footer>выбор задания</footer>
    </section>
    <section class="task-summary-panel">
      <div class="task-geometry-preview">
        <Show when={props.active && info.value()?.scene} fallback={<div class="plot-empty">{info.loading() ? "Чтение геометрии…" : "Геометрия выбранного задания"}</div>}>
          <ThreeGeometryViewport scene={info.value().scene} mode="solid" projection="orthographic" autoFit={true} showEdges={true}
            filters={{ symmetry: { local: false, axial: false, periodic: false, mirror: false } }} />
        </Show>
      </div>
      <textarea readOnly aria-label="Сводка исходных данных" value={info.value()?.summary.input ?? ""} />
      <footer>исходные данные</footer>
    </section>
    <TaskMediaPanel taskHandle={candidate()?.handle} active={props.active}
      disabled={props.busy || selectionReceiving() || accessBusy()} refreshKey={[candidate(), props.docsRevision]} onBusyChange={setGalleryBusy}
      onEditProtocol={(filename, opener) => {
        const item = candidate();
        if (!item || props.busy || browserBusy()) return;
        props.onEditProtocol?.({ ...item, plotLabel: `${root().name}/${project()}/${item.name}`, workspace: { rootHandle: root() } }, filename, opener);
      }}
      resultsSummary={info.value()?.summary.output ?? ""} />
    <dialog class="task-selection-error-dialog" aria-label="Не удалось показать задание в Editor"
      aria-describedby="task-selection-error-message" ref={selectionErrorDialog} onClose={() => {
        setSelectionError("");
        selectionErrorReturnFocus?.focus();
        selectionErrorReturnFocus = null;
      }}>
      <p id="task-selection-error-message">{selectionError()}</p>
      <button type="button" autofocus onClick={() => selectionErrorDialog.close()}>Закрыть</button>
    </dialog>
  </div>;
}
