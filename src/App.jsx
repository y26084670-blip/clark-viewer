import { createSignal, ErrorBoundary, For, lazy, onCleanup, onMount, Show, Switch, Match, Suspense } from "solid-js";
import { Tasks } from "./tabs/Tasks.jsx";
import { loadTask } from "./services/taskLoadService.js";
import { ResultService } from "./services/resultService.js";
import { mapResultObjects } from "./services/results/resultMappings.js";
import { AboutDialog } from "./components/AboutDialog.jsx";
import { ViewerToolsMenu } from "./components/movie/ViewerToolsMenu.jsx";
import { createMovieExportController } from "./services/movie/movieExportController.js";
import { createMovieGifEncoder } from "./services/movie/movieGifEncoder.js";
import { backfillTaskResultRanges } from "./services/results/resultRangeBackfill.js";

const tabs = ["Выбор задания", "Источники / Поле 3D", "Рабочие точки", "Поле на линиях", "Поле в областях", "Потоки", "Силы / Потери"];

const TAB_MODULE_LOADERS = Object.freeze({
  SourcesFields3D: () => import("./tabs/SourcesFields3D.jsx"),
  WorkingPoints: () => import("./tabs/WorkingPoints.jsx"),
  FieldLines: () => import("./tabs/FieldLines.jsx"),
  FieldAreas: () => import("./tabs/FieldAreas.jsx"),
  Fluxes: () => import("./tabs/Fluxes.jsx"),
  ForcesMoments: () => import("./tabs/ForcesMoments.jsx"),
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
const FieldAreas = tabComponent("FieldAreas");
const Fluxes = tabComponent("Fluxes");
const ForcesMoments = tabComponent("ForcesMoments");
export default function App() {
  onMount(() => {
    // Load all lazy tab chunks while this HTML version is current. This keeps
    // an already-open Viewer usable after a later GitHub Pages deployment
    // replaces hashed asset names.
    void preloadViewerTabs();
  });
  const [active, setActive] = createSignal(0), [task, setTask] = createSignal(null), [path, setPath] = createSignal("");
  const [time, setTime] = createSignal(0), [elements, setElements] = createSignal([]), [regions, setRegions] = createSignal([]);
  const [coils, setCoils] = createSignal(null);
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [movieBusy, setMovieBusy] = createSignal(false), [movieAdapter, setMovieAdapter] = createSignal(null);
  const movieController = createMovieExportController({ createEncoder: createMovieGifEncoder,
    onAdapterChange: adapter => setMovieAdapter(() => adapter) });
  let loadRevision = 0, activeReader;
  async function load(handle, newPath) {
    const revision = ++loadRevision;
    setBusy(true); setError("");
    let reader;
    try {
      const data = await loadTask(handle);
      if (revision !== loadRevision) return;
      let metadata = {};
      if (Object.keys(data.files).length) {
        reader = new ResultService();
        metadata = await reader.open(data.files);
      }
      if (revision !== loadRevision) { reader?.close(); return; }
      for (const [name, info] of Object.entries(metadata)) {
        if (!info.error && ["MH", "JE", "HS", "AS", "HV", "AV", "Q"].includes(name)) {
          try { mapResultObjects(data, name, info.header); }
          catch (error) { info.error = error.message; }
        }
      }
      activeReader?.close(); activeReader = reader;
      setTime(0); setElements(data.elements.map(row => row.id)); setRegions(data.regions.map(row => row.id)); setCoils(null);
      setTask({ ...data, reader, metadata }); setPath(newPath);
      setActive(1);
    } catch (error) {
      reader?.close(); if (revision === loadRevision) setError(`Не удалось загрузить задание: ${error.message}`);
    } finally { if (revision === loadRevision) setBusy(false); }
  }
  async function backfillRanges(options) {
    const current = task();
    if (!current) throw new Error("Задание не загружено");
    // requestPermission is invoked synchronously inside backfillTaskResultRanges,
    // while this call still belongs to the user's click.
    const operation = backfillTaskResultRanges(current, options);
    activeReader?.close(); activeReader = undefined;
    try {
      return await operation;
    } finally {
      if (task() === current) {
        const data = await loadTask(current.handle);
        let reader;
        try {
          let metadata = {};
          if (Object.keys(data.files).length) {
            reader = new ResultService();
            metadata = await reader.open(data.files);
          }
          for (const [name, info] of Object.entries(metadata)) {
            if (!info.error && ["MH", "JE", "HS", "AS", "HV", "AV", "Q"].includes(name)) {
              try { mapResultObjects(data, name, info.header); }
              catch (error) { info.error = error.message; }
            }
          }
          activeReader = reader;
          setTask({ ...data, reader, metadata });
        } catch (error) {
          reader?.close();
          throw new Error(`Диапазоны записаны, но результаты не удалось переоткрыть: ${error.message}`);
        }
      }
    }
  }
  function changeTime(index) {
    if (Number.isFinite(index)) setTime(Math.max(0, Math.min(task()?.general.countTimeSteps ?? 0, Math.trunc(index))));
  }
  onCleanup(() => { loadRevision++; movieController.dispose(); activeReader?.close(); });
  const movieDisabledReason = () => {
    if (movieBusy()) return "Создание GIF уже выполняется.";
    if (busy()) return "Дождитесь загрузки задания.";
    if (!task()) return "Загрузите задание.";
    if (!Number.isSafeInteger(task().general?.countTimeSteps) || task().general.countTimeSteps < 0
      || !Number.isFinite(task().general.timeStep) || task().general.timeStep < 0
      || (task().general.countTimeSteps > 0 && task().general.timeStep === 0)) return "Некорректное число интервалов или шаг времени задания.";
    if (active() < 1 || active() > 6) return "Откройте вкладку с результатами.";
    if (!movieAdapter()) return "Дождитесь готовности текущего графика.";
    return "";
  };
  const shared = {
    get task() { return task(); }, get time() { return time(); },
    setTime: index => { if (!movieBusy()) changeTime(index); }, setMovieTime: changeTime,
    registerMovieAdapter: movieController.register,
    get movieBusy() { return movieBusy(); },
    get elements() { return elements(); }, setElements: value => { if (!movieBusy()) setElements(value); },
    get regions() { return regions(); }, setRegions: value => { if (!movieBusy()) setRegions(value); },
    get coils() { return coils(); }, setCoils: value => { if (!movieBusy()) setCoils(value); },
  };
  return <div class="app-container">
    <header class="task-info-bar">
      <span class="program-name">E3D Viewer</span>
      <div class="task-path" title={path()}>{path() || "Задание не загружено"}</div>
      <AboutDialog />
    </header>
    <nav class="tabs-header" aria-label="Вкладки просмотра" inert={movieBusy()}>
      <For each={tabs}>{(title, i) => <button classList={{ active: active() === i() }} aria-current={active() === i() ? "page" : undefined}
        disabled={movieBusy()} onClick={() => { if (!movieBusy()) setActive(i()); }}>{title}</button>}</For>
      <ViewerToolsMenu task={task()} tabIndex={active()} frameCount={(task()?.general.countTimeSteps ?? 0) + 1}
        eligible={!movieDisabledReason()} disabledReason={movieDisabledReason()}
        backfillEligible={Boolean(task()) && !busy() && !movieBusy()}
        backfillDisabledReason={!task() ? "Загрузите задание." : busy() ? "Дождитесь загрузки задания." : movieBusy() ? "Дождитесь завершения текущей операции." : ""}
        onRun={options => movieController.run(options)} onBackfill={backfillRanges} onBusyChange={setMovieBusy} />
    </nav>
    <main class="tabs-body" inert={movieBusy()} aria-busy={movieBusy()}>
      <div class="task-tab" style={{ display: active() === 0 ? "flex" : "none" }}>
        <Tasks active={active() === 0} onLoad={(...args) => { if (!movieBusy()) return load(...args); }} loadedHandle={task()?.handle} busy={busy() || movieBusy()} error={error()} />
      </div>
      <Show when={active() !== 0}>
        <Show when={task()} fallback={<div class="empty-task"><p>Загрузите задание на первой вкладке</p><button onClick={() => setActive(0)}>Выбор задания</button></div>}>
          <ErrorBoundary fallback={(failure, reset) => <div class="empty-task">
            <p>Версия Viewer обновлена. Перезагрузите страницу.</p>
            <p class="tab-load-error">{failure?.message ?? String(failure)}</p>
            <button type="button" onClick={() => window.location.reload()}>Перезагрузить</button>
          </div>}>
            <Suspense fallback={<div class="empty-task">Загрузка вкладки…</div>}><Switch>
              <Match when={active() === 1}><SourcesFields3D {...shared} /></Match>
              <Match when={active() === 2}><WorkingPoints {...shared} /></Match>
              <Match when={active() === 3}><FieldLines {...shared} /></Match>
              <Match when={active() === 4}><FieldAreas {...shared} /></Match>
              <Match when={active() === 5}><Fluxes {...shared} /></Match>
              <Match when={active() === 6}><ForcesMoments {...shared} /></Match>
            </Switch></Suspense>
          </ErrorBoundary>
        </Show>
      </Show>
    </main>
  </div>;
}
