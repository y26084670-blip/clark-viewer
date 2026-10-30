import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { textProtocolWriteAccess } from "../../services/taskTextProtocols.js";

export function TaskTextProtocolsDialog(props) {
  const titleId = createUniqueId();
  const [selected, setSelected] = createSignal(null), [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal(""), [error, setError] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  let dialog, opener, worker, disposed = false, cancelRequested = false;
  function finish() {
    worker?.terminate(); worker = null;
    if (!disposed) { setBusy(false); setCommitting(false); props.onBusyChange?.(false); }
  }
  function close() {
    if (busy()) {
      if (!committing()) { cancelRequested = true; worker?.postMessage({ action: "cancel" }); setStatus("Отмена…"); }
      return;
    }
    dialog.close(); setSelected(null); opener?.focus();
  }
  async function run(action) {
    if (busy() || !selected()) return;
    const handle = selected();
    cancelRequested = false;
    setBusy(true); setStatus(action === "create" ? "Подготовка протоколов…" : "Удаление протоколов…"); setError("");
    props.onBusyChange?.(true);
    try {
      // Request access directly in the click handler, while user activation is live.
      await textProtocolWriteAccess(handle);
      if (disposed) return;
      if (cancelRequested) { setStatus("Операция отменена"); finish(); return; }
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
      worker.postMessage({ action, handle });
    } catch (failure) { if (!disposed) { setStatus(""); setError(failure.message); finish(); } }
  }
  onCleanup(() => { disposed = true; worker?.postMessage({ action: "cancel" }); if (worker) worker.onmessage = ({ data }) => { if (!data.progress) worker?.terminate(); }; });
  return <>
    <button class="task-text-protocols-button" type="button" disabled={props.disabled || props.active === false || !props.taskHandle}
      title="Создать или удалить текстовые протоколы выделенного задания" onClick={event => {
        opener = event.currentTarget; setSelected(props.taskHandle); setStatus(""); setError(""); dialog.showModal();
      }}>Протоколы...</button>
    <Portal><dialog ref={dialog} class="task-text-protocols-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id={titleId}>Текстовые протоколы</h2>
      <p class="task-text-protocols-name">{selected()?.name}</p>
      <p>Источники J и M, состояние ВТСП, поле в точках и объёмных областях. Все протоколы обрабатываются вместе.</p>
      <Show when={status()}><p role="status">{status()}</p></Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <div class="task-text-protocols-actions">
        <button type="button" disabled={busy()} onClick={() => run("create")}>Создать</button>
        <button type="button" disabled={busy()} onClick={() => run("delete")}>Удалить</button>
        <button type="button" autofocus disabled={committing()} onClick={close}>Отмена</button>
      </div>
    </dialog></Portal>
  </>;
}
