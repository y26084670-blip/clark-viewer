import { batch, createSignal, For, Show, onCleanup } from "solid-js";
import { createLastOpenedTaskHistory, sortTaskDirectories } from "../services/taskLastOpenedService.js";
import { createTaskSelectionChannel, readTaskSelection } from "../services/taskSelectionChannel.js";
import { loadTaskInput, readTaskSummaries } from "../services/taskLoadService.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { buildGeometryScene } from "../services/visualization/geometrySceneModel.js";
import { ThreeGeometryViewport } from "../components/geometry/ThreeGeometryViewport.jsx";
import { TaskGifGallery } from "../components/tasks/TaskGifGallery.jsx";
import { TaskStatusCells } from "../components/tasks/TaskStatusCells.jsx";
import { LastOpenedTaskMarker, ProjectSelectValue } from "../components/tasks/LastOpenedTaskMarker.jsx";
import { useTaskStatuses } from "../services/taskStatusMonitor.js";
import { createTaskTestProtocolWindow } from "../services/taskTestProtocolWindow.js";
import "../components/geometry/ResultsGeometryViewport.css";

export function Tasks(props) {
  const [root, setRoot] = createSignal(null), [projects, setProjects] = createSignal([]);
  const [project, setProject] = createSignal(""), [tasks, setTasks] = createSignal([]);
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
  const browserBusy = () => galleryBusy() || selectionReceiving() || protocolBusy();
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
        isCurrent: () => !disposed && handle === root() && current === revision && !props.busy,
      });
      batch(() => {
        setProjects(selected.projects); setProject(selected.project.name);
        setTasks(selected.tasks); setCandidate({ ...selected.task }); setError("");
      });
      props.onShowTasks?.();
      setSelectionNotice(`Выбрано задание из Editor: ${selected.project.name}/${selected.task.name}`);
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
      await selectionChannel.select({ baseHandle: handle, projectName: name, taskName: item.name });
      if (!disposed) setSelectionNotice(`В Editor выделено задание: ${name}/${item.name}`);
    } catch (error) { if (!disposed) showSelectionError(error.message, sourceButton); }
    finally { if (!disposed) setSelectionSending(false); }
  }
  async function subdirectories(handle) {
    const result = [];
    for await (const [name, item] of handle.entries()) if (item.kind === "directory") result.push({ name, handle: item });
    return sortTaskDirectories(result);
  }
  async function pickRoot() {
    if (browserBusy()) return;
    setError("");
    if (!window.isSecureContext || typeof window.showDirectoryPicker !== "function") {
      setError("Выбор каталога недоступен. Откройте приложение по HTTPS или localhost в Chrome либо Edge."); return;
    }
    const request = ++pickRevision;
    try {
      const picked = await window.showDirectoryPicker({ mode: "readwrite" });
      const previous = root();
      const sameDirectory = previous ? await previous.isSameEntry(picked) : false;
      const handle = sameDirectory ? previous : picked;
      if (disposed || request !== pickRevision) return;
      const current = ++revision;
      const entries = await subdirectories(handle);
      if (disposed || current !== revision || request !== pickRevision) return;
      setRoot(handle); setProjects(entries); setProject(""); setTasks([]); setCandidate(null);
      await lastTaskHistory.open(handle);
    } catch (error) { if (!disposed && request === pickRevision && error.name !== "AbortError") setError(error.message); }
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
    <section class="task-browser-panel">
      <div class="task-browser-content">
        <button class="folder-button" disabled={browserBusy()} onClick={pickRoot}>Выбрать каталог с проектами</button>
        <div class="root-name">{root() ? `Корневой каталог: ${root().name}` : "Каталог не выбран"}</div>
        <label class="field-label">Список проектов</label>
        <select class="project-select task-project-select" value={project()} disabled={browserBusy()} onChange={event => pickProject(event.currentTarget.value)} aria-label="Список проектов">
          <ProjectSelectValue value={project()} placeholder="Выберите проект" marked={project() === lastProjectName()} />
          <option value="">Выберите проект</option><For each={projects()}>{item => <option value={item.name}><Show when={item.name === lastProjectName()}><LastOpenedTaskMarker label="Последний открытый проект" /></Show>{item.name}</option>}</For>
        </select>
        <div class="task-list-heading">
          <div class="field-label">Список заданий</div>
          <button type="button" class="task-status-refresh" disabled={!tasks().length || taskStatus.busy() || galleryBusy()}
            aria-label="Обновить признаки состояния заданий" aria-busy={taskStatus.busy()}
            title="Обновить признаки состояния заданий" onClick={() => { void taskStatus.refresh(); }}>↻</button>
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
              onOpenProtocols={() => { void openTestProtocols(item); }} /><span class="task-status-name"><Show when={isLastTask(item)}><LastOpenedTaskMarker label="Последнее открытое задание" /></Show>{item.name}</span>
          </div>}</For>
        </div>
        <div class="task-load-row">
        <button class="load-button" disabled={!candidate() || props.busy || browserBusy()} onClick={load}>{props.busy ? "Загрузка…" : "Загрузить для просмотра"}</button>
        <button type="button" class="task-cross-open-button"
          disabled={!candidate() || !selectionChannel.supported || props.busy || browserBusy() || selectionSending()}
          aria-busy={selectionSending()}
          title="Выбрать проект и выделить это задание в открытом Editor с тем же базовым каталогом"
          onClick={showInEditor}>Выбрать в Editor</button>
        </div>
        <Show when={props.loadedHandle === candidate()?.handle && props.loadedHandle}><div class="loaded-note">✓ Задание загружено</div></Show>
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
    <section class="task-results-panel">
      <TaskGifGallery taskHandle={candidate()?.handle} active={props.active} disabled={props.busy || selectionReceiving()}
        onBusyChange={setGalleryBusy} />
      <textarea readOnly aria-label="Сводка результатов расчёта" value={info.value()?.summary.output ?? ""} />
      <footer>результаты</footer>
    </section>
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
