import { createSignal, For, Show } from "solid-js";
import { loadTaskInput, readTaskSummaries } from "../services/taskLoadService.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { buildGeometryScene } from "../services/visualization/geometrySceneModel.js";
import { ThreeGeometryViewport } from "../components/geometry/ThreeGeometryViewport.jsx";
import "../components/geometry/ResultsGeometryViewport.css";

export function Tasks(props) {
  const [root, setRoot] = createSignal(null), [projects, setProjects] = createSignal([]);
  const [project, setProject] = createSignal(""), [tasks, setTasks] = createSignal([]);
  const [candidate, setCandidate] = createSignal(null), [error, setError] = createSignal("");
  let revision = 0;
  async function subdirectories(handle) {
    const result = [];
    for await (const [name, item] of handle.entries()) if (item.kind === "directory") result.push({ name, handle: item });
    return result.sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
  }
  async function pickRoot() {
    setError("");
    if (!window.isSecureContext || typeof window.showDirectoryPicker !== "function") {
      setError("Выбор каталога недоступен. Откройте приложение по HTTPS или localhost в Chrome либо Edge."); return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      if (!props.admin && handle.name !== "clark.projects") throw new Error("Выберите каталог clark.projects");
      const current = ++revision;
      const entries = await subdirectories(handle);
      if (current !== revision) return;
      setRoot(handle); setProjects(entries); setProject(""); setTasks([]); setCandidate(null);
    } catch (error) { if (error.name !== "AbortError") setError(error.message); }
  }
  async function pickProject(name) {
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
    const item = candidate();
    if (item) props.onLoad(item.handle, `${root().name}/${project()}/${item.name}`);
  }
  return <div class="tasks-layout">
    <section class="task-browser-panel">
      <div class="task-browser-content">
        <button class="folder-button" onClick={pickRoot}>{props.admin ? "Выбрать каталог с проектами" : "Выбрать каталог clark.projects"}</button>
        <div class="root-name">{root() ? `Корневой каталог: ${root().name}` : "Каталог не выбран"}</div>
        <label class="field-label">Список проектов</label>
        <select class="project-select" value={project()} onChange={event => pickProject(event.currentTarget.value)} aria-label="Список проектов">
          <option value="">Выберите проект</option><For each={projects()}>{item => <option value={item.name}>{item.name}</option>}</For>
        </select>
        <div class="field-label">Список заданий</div>
        <div class="task-list" role="listbox" aria-label="Список заданий">
          <For each={tasks()}>{item => <button role="option" aria-selected={candidate()?.handle === item.handle}
            classList={{ selected: candidate()?.handle === item.handle }} onClick={() => setCandidate({ ...item })}>{item.name}</button>}</For>
        </div>
        <button class="load-button" disabled={!candidate() || props.busy} onClick={load}>{props.busy ? "Загрузка…" : "Загрузить для просмотра"}</button>
        <Show when={props.loadedHandle === candidate()?.handle && props.loadedHandle}><div class="loaded-note">✓ Задание загружено</div></Show>
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
      <textarea readOnly aria-label="Сводка результатов расчёта" value={info.value()?.summary.output ?? ""} />
      <footer>результаты</footer>
    </section>
  </div>;
}
