import { readTaskPlanarMode } from "./services/taskStatusService.js";
import { createEffect, createSignal, ErrorBoundary, For, lazy, onCleanup, onMount, Show, Switch, Match, Suspense } from "solid-js";
import { Portal } from "solid-js/web";
import { Tasks } from "./tabs/Tasks.jsx";
import { loadTask } from "./services/taskLoadService.js";
import { ResultService } from "./services/resultService.js";
import { mapResultObjects } from "./services/results/resultMappings.js";
import { AboutDialog } from "./components/AboutDialog.jsx";
import { WhatsNewDialog } from "./components/updates/WhatsNewDialog.jsx";
import { ViewerToolsMenu } from "./components/movie/ViewerToolsMenu.jsx";
import { TaskProtocolDialog } from "./components/protocol/TaskProtocolDialog.jsx";
import { createMovieExportController } from "./services/movie/movieExportController.js";
import { createMovieWebmEncoder } from "./services/movie/movieWebmEncoder.js";
import { installBrowserDefaults } from "./services/browserDefaults.js";
import { createPlotTaskStore } from "./services/results/plotTaskSources.js";

const tabs = ["Выбор задания", "Источники / Поле 3D", "Рабочие точки", "Поле на линиях", "Графики"];

const TAB_MODULE_LOADERS = Object.freeze({
  SourcesFields3D: () => import("./tabs/SourcesFields3D.jsx"),
  WorkingPoints: () => import("./tabs/WorkingPoints.jsx"),
  FieldLines: () => import("./tabs/FieldLines.jsx"),
  PlotConstructor: () => import("./tabs/PlotConstructor.jsx"),
});
const tabModulePromises = new Map();
export function loadViewerTabModule(name) {
  const loader = TAB_MODULE_LOADERS[name];
  if (!loader) return Promise.reject(new Error(`Неизвестная вкладка: ${name}`));
  if (!tabModulePromises.has(name)) tabModulePromises.set(name, loader());
  return tabModulePromises.get(name);
}
export function preloadViewerTabs() {
  return Promise.allSettled(Object.keys(TAB_MODULE_LOADERS).map(loadViewerTabModule));
}
const tabComponent = (name, exportName = name) => lazy(() =>
  loadViewerTabModule(name).then(module => ({ default: module[exportName] })));
const SourcesFields3D = tabComponent("SourcesFields3D");
const WorkingPoints = tabComponent("WorkingPoints");
const FieldLines = tabComponent("FieldLines");
const PlotConstructor = tabComponent("PlotConstructor");
export default function App() {
  let workspace;
  onMount(() => {
    // Load all lazy tab chunks while this HTML version is current. This keeps
    // an already-open Viewer usable after a later GitHub Pages deployment
    // replaces hashed asset names.
    void preloadViewerTabs();
    onCleanup(installBrowserDefaults(window));
  });
  const [active, setActive] = createSignal(0), [task, setTask] = createSignal(null), [path, setPath] = createSignal("");
  const [time, setTime] = createSignal(0), [elements, setElements] = createSignal([]), [regions, setRegions] = createSignal([]);
  const [plotRecipes, setPlotRecipes] = createSignal([]);
  const [protocolEntries, setProtocolEntries] = createSignal({});
  const [protocolSession, setProtocolSession] = createSignal({ handle: null, files: new Map(), lastFilename: "protocol.html" });
  let protocolTaskHandle;
  createEffect(() => {
    const handle = task()?.handle, previous = protocolTaskHandle;
    if (!handle || handle === previous) return;
    protocolTaskHandle = handle;
    void (async () => {
      let same = false;
      try { same = Boolean(previous?.isSameEntry && await previous.isSameEntry(handle)); } catch { /* Separate task. */ }
      if (!same && task()?.handle === handle) setProtocolSession({ handle, files: new Map(), lastFilename: "protocol.html" });
    })();
  });
  const [protocolRequest, setProtocolRequest] = createSignal(null), [docsRevision, setDocsRevision] = createSignal(0);
  const [plotSources, setPlotSources] = createSignal([]);
  const [activePlotId, setActivePlotId] = createSignal(null);
  const [plotRoot, setPlotRoot] = createSignal(null), [plotTaskSource, setPlotTaskSource] = createSignal({});
  const plotTaskStore = createPlotTaskStore({ onChange: setPlotTaskSource });
  createEffect(() => plotTaskStore.retain(plotRecipes().flatMap(plot => plot.curves.map(curve => curve.yTask))));
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [movieBusy, setMovieBusy] = createSignal(false), [movieAdapter, setMovieAdapter] = createSignal(null);
  const movieController = createMovieExportController({ createEncoder: createMovieWebmEncoder,
    onAdapterChange: adapter => setMovieAdapter(() => adapter) });
  function createProtocol(opener) {
    if (!task() || busy() || movieBusy()) return;
    setProtocolRequest({ task: task(), filename: "", opener, loadedTask: task() });
  }
  async function editProtocol(documentTask, filename, opener) {
    if (busy() || movieBusy()) return;
    const loaded = task();
    let same = loaded?.handle === documentTask.handle;
    setMovieBusy(true);
    try {
      if (!same && loaded?.handle?.isSameEntry) same = await loaded.handle.isSameEntry(documentTask.handle);
    } catch { /* An unrelated or unavailable loaded task contributes no snapshots. */ }
    finally { setMovieBusy(false); }
    setProtocolRequest({ task: documentTask, filename, opener, loadedTask: same ? loaded : null });
  }
  const protocolUsesSelection = () => Boolean(protocolRequest()?.loadedTask) && protocolRequest().loadedTask === task();
  // Keep the condition out of the JSX getter: the dialog also reads it after await.
  const protocolDialogEntries = () => protocolUsesSelection() ? protocolEntries() : {};
  function closeProtocol() {
    const opener = protocolRequest()?.opener;
    setProtocolRequest(null);
    queueMicrotask(() => { if (opener?.isConnected) opener.focus(); });
  }
  let loadRevision = 0, activeReader;
  async function load(handle, newPath, workspace) {
    const revision = ++loadRevision;
    setBusy(true); setError("");
    let reader;
    try {
      const data = await loadTask(handle);
      if (revision !== loadRevision) return false;
      let metadata = {};
      if (Object.keys(data.files).length) {
        reader = new ResultService();
        metadata = await reader.open(data.files);
      }
      if (revision !== loadRevision) { reader?.close(); return false; }
      for (const [name, info] of Object.entries(metadata)) {
        if (!info.error && ["MH", "JE", "HS", "AS", "HV", "AV", "Q"].includes(name)) {
          try { mapResultObjects(data, name, info.header); }
          catch (error) { info.error = error.message; }
        }
      }
      activeReader?.close(); activeReader = reader;
      setTime(0); setElements([]); setRegions([]);
      setPlotRecipes([]);
      setProtocolEntries({});
      plotTaskStore.clear();
      setPlotSources([]);
      setActivePlotId(null);
      setTask({ ...data, reader, metadata, workspace, plotLabel: newPath }); setPath(newPath);
      setActive(1);
      return true;
    } catch (error) {
      reader?.close(); if (revision === loadRevision) setError(`Не удалось загрузить задание: ${error.message}`);
      return false;
    } finally { if (revision === loadRevision) setBusy(false); }
  }
  function changeTime(index) {
    if (Number.isFinite(index)) setTime(Math.max(0, Math.min(task()?.general.countTimeSteps ?? 0, Math.trunc(index))));
  }
  onCleanup(() => { loadRevision++; movieController.dispose(); activeReader?.close(); plotTaskStore.clear(); });
  const movieDisabledReason = () => {
    if (movieBusy()) return "Создание WebM уже выполняется.";
    if (busy()) return "Дождитесь загрузки задания.";
    if (!task()) return "Загрузите задание.";
    if (!Number.isSafeInteger(task().general?.countTimeSteps) || task().general.countTimeSteps < 0
      || !Number.isFinite(task().general.timeStep) || task().general.timeStep < 0
      || (task().general.countTimeSteps > 0 && task().general.timeStep === 0)) return "Некорректное число интервалов или шаг времени задания.";
    if (active() < 1 || active() > 4) return "Откройте вкладку с результатами.";
    if (!movieAdapter()) return "Дождитесь готовности текущего графика.";
    return "";
  };
  async function refreshLoadedPlanarMode() {
    const loaded = task();
    if (!loaded) return;
    const marker = await readTaskPlanarMode(loaded.handle);
    if (task() === loaded && loaded.planar2D !== (marker.exists === true)) {
      setTask({ ...loaded, planar2D: marker.exists === true });
    }
  }
  const shared = {
    get task() { return task(); }, get time() { return time(); },
    setTime: index => { if (!movieBusy()) changeTime(index); }, setMovieTime: changeTime,
    registerMovieAdapter: movieController.register,
    get movieBusy() { return movieBusy(); },
    get protocolEntries() { return protocolEntries(); },
    setProtocolEntry: (key, block) => setProtocolEntries(previous => {
      const next = { ...previous }; if (block) next[key] = block; else delete next[key]; return next;
    }),
    setProtocolBusy: setMovieBusy,
    get elements() { return elements(); }, setElements: value => { if (!movieBusy()) setElements(value); },
    get regions() { return regions(); }, setRegions: value => { if (!movieBusy()) setRegions(value); },
    get plotRecipes() { return plotRecipes(); }, setPlotRecipes,
    get plotSources() { return plotSources(); }, setPlotSources,
    get activePlotId() { return activePlotId(); }, setActivePlotId,
    get plotRoot() { return plotRoot(); },
    get plotTaskSource() { return plotTaskSource(); }, selectPlotTask: plotTaskStore.select,
  };
  return <div class="app-container">
    <header class="task-info-bar">
      <span class="program-name">E3D Viewer</span>
      <div class="task-path" title={path()}>{path() || "Задание не загружено"}</div>
      <WhatsNewDialog app="viewer" />
      <AboutDialog />
    </header>
    <nav class="tabs-header" aria-label="Вкладки просмотра" inert={movieBusy()}>
      <For each={tabs}>{(title, i) => <button classList={{ active: active() === i() }} aria-current={active() === i() ? "page" : undefined}
        disabled={movieBusy()} onClick={() => { if (!movieBusy()) setActive(i()); }}>{title}</button>}</For>
      <ViewerToolsMenu task={task()} tabIndex={active()} frameCount={(task()?.general.countTimeSteps ?? 0) + 1}
        time={time()} getWorkspace={() => workspace}
        onCreateProtocol={createProtocol}
        eligible={!movieDisabledReason()}
        taskActionsEligible={Boolean(task()) && !busy() && !movieBusy()}
        onRun={options => movieController.run(options)} onBusyChange={setMovieBusy} />
    </nav>
    <main class="tabs-body" ref={workspace} inert={movieBusy()} aria-busy={movieBusy()}>
      <div class="task-tab" style={{ display: active() === 0 ? "flex" : "none" }}>
        <Tasks active={active() === 0} onRootChange={setPlotRoot} onShowTasks={() => setActive(0)} onLoad={(...args) => { if (!movieBusy()) return load(...args); }} loadedHandle={task()?.handle} busy={busy() || movieBusy()} error={error()}
          onTaskListRefresh={refreshLoadedPlanarMode} onEditProtocol={editProtocol} docsRevision={docsRevision()} />
      </div>
      <Show when={active() !== 0}>
        <Show when={task()} fallback={<div class="empty-task"><p>Загрузите задание на первой вкладке</p><button onClick={() => setActive(0)}>Выбор задания</button></div>}>
          <ErrorBoundary fallback={(failure, reset) => <div class="empty-task">
            <p>Версия Viewer обновлена. Перезагрузите страницу.</p>
            <p class="tab-load-error">{failure?.message ?? String(failure)}</p>
            <button type="button" onClick={() => window.location.reload()}>Перезагрузить</button>
          </div>}>
            <Suspense fallback={<Show when={active() !== 1}><div class="empty-task">Загрузка вкладки…</div></Show>}><Switch>
              <Match when={active() === 1}><SourcesFields3D {...shared} /></Match>
              <Match when={active() === 2}><WorkingPoints {...shared} /></Match>
              <Match when={active() === 3}><FieldLines {...shared} /></Match>
              <Match when={active() === 4}><PlotConstructor {...shared} /></Match>
            </Switch></Suspense>
          </ErrorBoundary>
        </Show>
      </Show>
    </main>
    <Portal><TaskProtocolDialog open={Boolean(protocolRequest())} task={protocolRequest()?.task}
      initialFilename={protocolRequest()?.filename ?? ""} entries={protocolDialogEntries()} session={protocolSession()}
      onRemoveBlock={id => { if (protocolUsesSelection()) setProtocolEntries(previous => Object.fromEntries(Object.entries(previous).filter(([, block]) => block.id !== id))); }}
      onChanged={() => setDocsRevision(value => value + 1)} onBusyChange={setMovieBusy} onClose={closeProtocol} /></Portal>
  </div>;
}
