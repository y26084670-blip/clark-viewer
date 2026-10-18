import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { readConditionsContext, prepareConditionsRequest, waitForConditionsResult } from "../../services/taskConditionsService.js";

export function TaskConditionsDialog(props) {
  const titleId = createUniqueId();
  const [context, setContext] = createSignal(null), [mpiRanks, setMpiRanks] = createSignal("");
  const [replace, setReplace] = createSignal(false), [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false), [error, setError] = createSignal(""), [saved, setSaved] = createSignal(false);
  let dialog, input, controller, revision = 0;
  function close() { if (!busy()) props.onClose?.(); }
  async function initialize(task) {
    const current = ++revision;
    setContext(null); setMpiRanks(""); setReplace(false); setError(""); setSaved(false); setLoading(true);
    try { const value = await readConditionsContext(task); if (current === revision) setContext(value); }
    catch (failure) { if (current === revision) setError(failure.message); }
    finally { if (current === revision) { setLoading(false); queueMicrotask(() => input?.focus()); } }
  }
  async function save(event) {
    event.preventDefault();
    if (busy() || !context() || saved()) return;
    const task = props.task, current = revision, abort = new AbortController(); controller = abort;
    setError(""); setBusy(true); props.onBusyChange?.(true);
    try {
      const request = await prepareConditionsRequest(task, mpiRanks(), replace(), { signal: abort.signal });
      abort.signal.throwIfAborted();
      window.location.href = request.uri;
      await waitForConditionsResult(request, { signal: abort.signal });
      if (current === revision) setSaved(true);
    } catch (failure) {
      if (!abort.signal.aborted && current === revision) {
        setError(failure.message);
        try {
          const value = await readConditionsContext(task);
          if (!abort.signal.aborted && current === revision) setContext(value);
        } catch { /* retain the original error */ }
      }
    } finally {
      if (controller === abort) { controller = null; setBusy(false); props.onBusyChange?.(false); }
    }
  }
  createEffect(() => {
    const open = props.open, task = props.task;
    if (open) { if (!dialog.open) dialog.showModal(); void initialize(task); }
    else { revision++; controller?.abort(); if (dialog.open) dialog.close(); }
  });
  onCleanup(() => { revision++; controller?.abort(); if (dialog?.open) dialog.close(); });
  return <dialog ref={dialog} class="viewer-movie-dialog" aria-labelledby={titleId} aria-busy={busy() || loading()}
    onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <h2 id={titleId}>Сохранить условия расчета</h2>
    <p>{props.task?.name} · <code>output3XX/conditions.json</code></p>
    <p class="viewer-movie-note">Будут записаны характеристики текущего компьютера. Число процессов укажите по выполненному расчёту. Если задание перенесено с другой машины, сформируйте файл на машине расчёта.</p>
    <p class="viewer-movie-note">Дата в файле — момент его формирования. Файл можно создать для любого режима расчёта; перенос в архив теста выполняется вручную.</p>
    <Show when={loading()}><p role="status">Проверка каталога задания…</p></Show>
    <form onSubmit={save}>
      <Show when={context()}>
        <label class="viewer-movie-interval">Использовано MPI-процессов
          <input ref={input} type="number" min="1" max="2147483647" step="1" required value={mpiRanks()}
            disabled={busy() || saved()} onInput={event => setMpiRanks(event.currentTarget.value)} />
        </label>
        <Show when={context()?.exists && !saved()}>
          <p><label class="viewer-movie-task-save"><input type="checkbox" checked={replace()} disabled={busy()}
            onChange={event => setReplace(event.currentTarget.checked)} />Заменить существующий conditions.json</label></p>
        </Show>
      </Show>
      <Show when={busy()}><p role="status">Ожидание локального помощника Clark…</p></Show>
      <Show when={error()}><p class="viewer-movie-error" role="alert">{error()}</p></Show>
      <Show when={saved()}><p class="viewer-movie-saved" role="status">Файл output3XX/conditions.json сформирован.</p></Show>
      <div class="viewer-movie-actions">
        <button type="submit" disabled={!context() || busy() || saved() || !mpiRanks() || (context()?.exists && !replace())}>Сформировать</button>
        <button type="button" disabled={busy()} onClick={close}>Закрыть</button>
      </div>
    </form>
  </dialog>;
}
