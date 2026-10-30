import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { listExistingTextProtocols, textProtocolWriteAccess } from "../../services/taskTextProtocols.js";
import "./TaskTextProtocolsDialog.css";

export function TaskTextProtocolsDialog(props) {
  const titleId = createUniqueId();
  const [selected, setSelected] = createSignal(null), [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal(""), [error, setError] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [action, setAction] = createSignal(null), [checking, setChecking] = createSignal(false);
  let dialog, opener, worker, presence, disposed = false, cancelRequested = false;
  async function refreshAction() {
    presence?.abort();
    if (disposed || !selected()) return;
    const request = presence = new AbortController(), handle = selected();
    setChecking(true); setAction(null);
    try {
      const files = await listExistingTextProtocols(handle, { signal: request.signal });
      if (!disposed && !request.signal.aborted) setAction(files.length ? "delete" : "create");
    } catch (failure) {
      if (!disposed && !request.signal.aborted) setError(`Не удалось проверить протоколы: ${failure.message}`);
    } finally { if (!disposed && presence === request) setChecking(false); }
  }
  function finish() {
    worker?.terminate(); worker = null;
    if (!disposed) { setBusy(false); setCommitting(false); props.onBusyChange?.(false); void refreshAction(); }
  }
  function close() {
    if (busy()) {
      if (!committing()) { cancelRequested = true; worker?.postMessage({ action: "cancel" }); setStatus("Отмена…"); }
      return;
    }
    presence?.abort(); dialog.close(); setSelected(null); opener?.focus();
  }
  async function run() {
    if (busy() || checking() || !action() || !selected()) return;
    const handle = selected(), requested = action();
    cancelRequested = false;
    setBusy(true); setStatus(requested === "create" ? "Подготовка протоколов…" : "Удаление протоколов…"); setError("");
    props.onBusyChange?.(true);
    try {
      // Request access directly in the click handler, while user activation is live.
      await textProtocolWriteAccess(handle);
      if (disposed) return;
      const files = await listExistingTextProtocols(handle);
      if (disposed) return;
      if (cancelRequested) { setStatus("Операция отменена"); finish(); return; }
      if (requested !== (files.length ? "delete" : "create")) {
        setStatus("Состав протоколов изменился. Выберите доступное действие."); finish(); return;
      }
      worker = new Worker(new URL("../../workers/textProtocols.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (disposed) return;
        if (data.progress) { setStatus(data.progress); if (data.committing) setCommitting(true); return; }
        if (data.error) { setStatus(""); setError(data.error); }
        else {
          const result = data.result;
          setStatus(result.created ? `Создано протоколов: ${result.created.length}.${result.skipped.length ? " Для остальных видов нет данных в задании." : ""}`
            : result.deleted.length ? `Удалено протоколов: ${result.deleted.length}.` : "Текстовые протоколы отсутствуют.");
        }
        finish();
      };
      worker.onerror = event => { if (!disposed) { setStatus(""); setError(event.message || "Не удалось обработать протоколы"); finish(); } };
      worker.postMessage({ action: requested, handle });
    } catch (failure) { if (!disposed) { setStatus(""); setError(failure.message); finish(); } }
  }
  const onFocus = () => { if (dialog?.open && !busy()) void refreshAction(); };
  window.addEventListener("focus", onFocus);
  onCleanup(() => {
    disposed = true; presence?.abort(); window.removeEventListener("focus", onFocus);
    worker?.postMessage({ action: "cancel" });
    if (worker) {
      const pendingWorker = worker;
      pendingWorker.onmessage = ({ data }) => { if (!data.progress) pendingWorker.terminate(); };
      pendingWorker.onerror = () => pendingWorker.terminate();
    }
  });
  return <>
    <button class="task-text-protocols-button" type="button" disabled={props.disabled || props.active === false || !props.taskHandle}
      title="Создать или удалить текстовые протоколы расчёта выделенного задания" onClick={event => {
        opener = event.currentTarget; setSelected(props.taskHandle); setStatus(""); setError(""); dialog.showModal(); void refreshAction();
      }}>Протоколы...</button>
    <Portal><dialog ref={dialog} class="task-text-protocols-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id={titleId}>Протоколы расчёта</h2>
      <p class="task-text-protocols-name">{selected()?.name}</p>
      <p>Источники J и M, состояние ВТСП, поле в точках и объёмных областях. Все протоколы выделенного задания обрабатываются вместе.</p>
      <Show when={checking()}><p role="status">Проверка протоколов…</p></Show>
      <Show when={status()}><p role="status">{status()}</p></Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <div class="task-text-protocols-actions">
        <button type="button" disabled={busy() || checking() || !action()} onClick={run}>{action() === "delete" ? "Удалить" : "Создать"}</button>
        <button type="button" autofocus disabled={committing()} onClick={close}>Отмена</button>
      </div>
    </dialog></Portal>
  </>;
}
