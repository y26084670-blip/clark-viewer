import { createSignal, For, lazy, onCleanup, Show, Switch, Match, Suspense } from "solid-js";
import { Tasks } from "./tabs/Tasks.jsx";
import { loadTask } from "./services/taskLoadService.js";
import { ResultService } from "./services/resultService.js";
import { mapResultObjects } from "./services/results/resultMappings.js";
import { version } from "../package.json";

const tabs = ["Выбор задания", "Источники/Поля 3D", "Рабочие точки", "Поле на линиях", "Поле в областях"];
const SourcesFields3D = lazy(() => import("./tabs/SourcesFields3D.jsx").then(module => ({ default: module.SourcesFields3D })));
const WorkingPoints = lazy(() => import("./tabs/WorkingPoints.jsx").then(module => ({ default: module.WorkingPoints })));
const FieldLines = lazy(() => import("./tabs/FieldLines.jsx").then(module => ({ default: module.FieldLines })));
const FieldAreas = lazy(() => import("./tabs/FieldAreas.jsx").then(module => ({ default: module.FieldAreas })));
export default function App() {
  const [active, setActive] = createSignal(0), [task, setTask] = createSignal(null), [path, setPath] = createSignal("");
  const [time, setTime] = createSignal(0), [elements, setElements] = createSignal([]), [regions, setRegions] = createSignal([]);
  const [admin, setAdmin] = createSignal(false), [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [information, setInformation] = createSignal(false);
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
      setTime(0); setElements(data.elements.length ? [data.elements[0].id] : []); setRegions(data.regions.length ? [data.regions[0].id] : []);
      setTask({ ...data, reader, metadata }); setPath(newPath);
    } catch (error) {
      reader?.close(); if (revision === loadRevision) setError(`Не удалось загрузить задание: ${error.message}`);
    } finally { if (revision === loadRevision) setBusy(false); }
  }
  function changeTime(index) {
    if (Number.isFinite(index)) setTime(Math.max(0, Math.min(task()?.general.countTimeSteps ?? 0, Math.trunc(index))));
  }
  onCleanup(() => { loadRevision++; activeReader?.close(); });
  const shared = {
    get task() { return task(); }, get time() { return time(); }, setTime: changeTime,
    get elements() { return elements(); }, setElements,
    get regions() { return regions(); }, setRegions,
  };
  return <div class="app-container">
    <header class="task-info-bar">
      <button class="program-button" onClick={() => setInformation(!information())} title="О программе">Clark Viewer <small>{version}</small></button>
      <div class="task-path" title={path()}>{path() || "Задание не загружено"}</div>
      <label class="admin-control" title="Открывать каталоги проектов с произвольным именем"><input type="checkbox" checked={admin()} onChange={event => setAdmin(event.currentTarget.checked)} />Админ</label>
    </header>
    <Show when={information()}><div class="program-information" role="dialog" aria-label="О программе Clark Viewer">
      <button class="dialog-close" onClick={() => setInformation(false)} aria-label="Закрыть">×</button>
      <strong>Clark Viewer {version}</strong><p>Просмотр результатов расчётов clark.AI.</p>
      <p>Выберите каталог clark.projects, проект и задание. Нажмите «Загрузить для просмотра».</p>
      <p>Исходные данные читаются из input3XX, результаты — из output3XX. Для доступа к каталогу используйте Chrome или Edge по HTTPS либо localhost.</p>
      <p>Разработчик: ChatGPT · Куратор: Кулаев Ю. · 2026 г.</p>
    </div></Show>
    <nav class="tabs-header" aria-label="Вкладки просмотра">
      <For each={tabs}>{(title, i) => <button classList={{ active: active() === i() }} aria-current={active() === i() ? "page" : undefined}
        onClick={() => setActive(i())}>{title}</button>}</For>
    </nav>
    <main class="tabs-body">
      <div class="task-tab" style={{ display: active() === 0 ? "flex" : "none" }}>
        <Tasks active={active() === 0} admin={admin()} onLoad={load} loadedHandle={task()?.handle} busy={busy()} error={error()} />
      </div>
      <Show when={active() !== 0}>
        <Show when={task()} fallback={<div class="empty-task"><p>Загрузите задание на первой вкладке</p><button onClick={() => setActive(0)}>Выбор задания</button></div>}>
          <Suspense fallback={<div class="empty-task">Загрузка вкладки…</div>}><Switch>
            <Match when={active() === 1}><SourcesFields3D {...shared} /></Match>
            <Match when={active() === 2}><WorkingPoints {...shared} /></Match>
            <Match when={active() === 3}><FieldLines {...shared} /></Match>
            <Match when={active() === 4}><FieldAreas {...shared} /></Match>
          </Switch></Suspense>
        </Show>
      </Show>
    </main>
  </div>;
}
