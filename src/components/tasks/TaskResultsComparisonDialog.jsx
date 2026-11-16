import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { compareTaskResults, listComparisonTasks } from "../../services/taskResultsComparisonService.js";
import "./TaskResultsComparisonDialog.css";

export function TaskResultsComparisonDialog(props) {
  let dialog;
  const [tasks, setTasks] = createSignal([]), [first, setFirst] = createSignal(""), [second, setSecond] = createSignal("");
  const [loading, setLoading] = createSignal(false), [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal(""), [progress, setProgress] = createSignal(""), [report, setReport] = createSignal("");
  createEffect(() => {
    const request = props.request;
    if (!request) { if (dialog.open) dialog.close(); return; }
    const controller = new AbortController();
    setTasks([]); setFirst(""); setSecond(""); setNotice(""); setLoading(true);
    if (!dialog.open) dialog.showModal();
    void listComparisonTasks(request.projects, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setTasks(result.tasks);
      setFirst(result.tasks.find(task => task.key === request.preferred)?.key ?? result.tasks[0]?.key ?? "");
      setNotice(result.notices.join("\n") || (result.tasks.length < 2 ? "Для сравнения нужны два задания в текущем списке проектов." : ""));
    }).catch(error => { if (!controller.signal.aborted) setNotice(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const request = props.request;
    const a = tasks().find(task => task.key === first()), b = tasks().find(task => task.key === second());
    setProgress(""); setBusy(false);
    if (!request || !a || !b) { setReport("Выберите два задания для сравнения."); return; }
    const controller = new AbortController();
    setBusy(true); setReport("Сравнение результатов…");
    void compareTaskResults(a, b, { signal: controller.signal,
      onProgress: message => { if (!controller.signal.aborted) setProgress(message); },
      workerFactory: () => new Worker(new URL("../../workers/taskResultsComparison.worker.js", import.meta.url), { type: "module" }),
    }).then(text => { if (!controller.signal.aborted) setReport(text); })
      .catch(error => { if (!controller.signal.aborted) setReport(`Не удалось сравнить результаты: ${error.message}`); })
      .finally(() => { if (!controller.signal.aborted) { setBusy(false); setProgress(""); } });
    onCleanup(() => controller.abort());
  });
  onCleanup(() => { if (dialog.open) dialog.close(); });
  return <dialog ref={dialog} class="task-results-comparison-dialog" aria-labelledby="task-results-comparison-title"
    onCancel={event => { event.preventDefault(); props.onClose(); }}>
    <h2 id="task-results-comparison-title">Сравнить результаты</h2>
    <For each={[["Задание 1", first, setFirst], ["Задание 2", second, setSecond]]}>{([label, value, setValue]) =>
      <label class="task-results-comparison-choice">{label}
        <select aria-label={label} value={value()} disabled={loading()} onChange={event => setValue(event.currentTarget.value)}>
          <option value="">Выберите задание</option>
          <For each={tasks()}>{task => <option value={task.key}>{task.label}</option>}</For>
        </select>
      </label>
    }</For>
    <Show when={notice()}><p class="task-results-comparison-notice" role="status">{notice()}</p></Show>
    <Show when={loading() || progress()}><p role="status">{loading() ? "Чтение списка заданий…" : progress()}</p></Show>
    <textarea aria-label="Результаты сравнения" readOnly wrap="off" value={report()} aria-busy={busy()} />
    <div class="task-results-comparison-actions"><button type="button" onClick={props.onClose}>Закрыть</button></div>
  </dialog>;
}
