import { createSignal, For, lazy, onCleanup, Show, Switch, Match, Suspense } from "solid-js";
import { Tasks } from "./tabs/Tasks.jsx";
import { loadTask } from "./services/taskLoadService.js";
import { ResultService } from "./services/resultService.js";
import { mapResultObjects } from "./services/results/resultMappings.js";
import { AboutDialog } from "./components/AboutDialog.jsx";
import { ViewerToolsMenu } from "./components/movie/ViewerToolsMenu.jsx";
import { createMovieExportController } from "./services/movie/movieExportController.js";
import { createMovieGifEncoder } from "./services/movie/movieGifEncoder.js";

const tabs = ["Выбор задания", "Источники / Поле 3D", "Рабочие точки", "Поле на линиях", "Поле в областях", "Потоки", "Силы / Потери"];
const SourcesFields3D = lazy(() => import("./tabs/SourcesFields3D.jsx").then(module => ({ default: module.SourcesFields3D })));
const WorkingPoints = lazy(() => import("./tabs/WorkingPoints.jsx").then(module => ({ default: module.WorkingPoints })));
const FieldLines = lazy(() => import("./tabs/FieldLines.jsx").then(module => ({ default: module.FieldLines })));
const FieldAreas = lazy(() => import("./tabs/FieldAreas.jsx").then(module => ({ default: module.FieldAreas })));
const Fluxes = lazy(() => import("./tabs/Fluxes.jsx").then(module => ({ default: module.Fluxes })));
const ForcesMoments = lazy(() => import("./tabs/ForcesMoments.jsx").then(module => ({ default: module.ForcesMoments })));
export default function App() {
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
  function changeTime(index) {
    if (Number.isFinite(index)) setTime(Math.max(0, Math.min(task()?.general.countTimeSteps ?? 0, Math.trunc(index))));
  }
  onCleanup(() => { loadRevision++; movieController.dispose(); activeReader?.close(); });
  const movieDisabledReason = () => {
    if (movieBusy()) return "Создание GIF уже выполняется.";
    if (busy()) return "Дождитесь загрузки задания.";
    if (!task()) return "Загрузите задание.";
    if (!Number.isSafeInteger(task().general?.countTimeSteps) || task().general.countTimeSteps <= 0
      || !Number.isFinite(task().general.timeStep) || !(task().general.timeStep > 0)) return "Создание GIF доступно для динамических заданий с несколькими моментами времени.";
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
        onRun={options => movieController.run(options)} onBusyChange={setMovieBusy} />
    </nav>
    <main class="tabs-body" inert={movieBusy()} aria-busy={movieBusy()}>
      <div class="task-tab" style={{ display: active() === 0 ? "flex" : "none" }}>
        <Tasks active={active() === 0} onLoad={(...args) => { if (!movieBusy()) return load(...args); }} loadedHandle={task()?.handle} busy={busy() || movieBusy()} error={error()} />
      </div>
      <Show when={active() !== 0}>
        <Show when={task()} fallback={<div class="empty-task"><p>Загрузите задание на первой вкладке</p><button onClick={() => setActive(0)}>Выбор задания</button></div>}>
          <Suspense fallback={<div class="empty-task">Загрузка вкладки…</div>}><Switch>
            <Match when={active() === 1}><SourcesFields3D {...shared} /></Match>
            <Match when={active() === 2}><WorkingPoints {...shared} /></Match>
            <Match when={active() === 3}><FieldLines {...shared} /></Match>
            <Match when={active() === 4}><FieldAreas {...shared} /></Match>
            <Match when={active() === 5}><Fluxes {...shared} /></Match>
            <Match when={active() === 6}><ForcesMoments {...shared} /></Match>
          </Switch></Suspense>
        </Show>
      </Show>
    </main>
  </div>;
}
