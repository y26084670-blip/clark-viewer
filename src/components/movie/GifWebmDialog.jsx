import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { convertTaskGifs } from "../../services/movie/convertTaskGifs.js";

export function GifWebmDialog(props) {
  let dialog, abort, disposed = false;
  const [busy, setBusy] = createSignal(false), [progress, setProgress] = createSignal(null);
  const [error, setError] = createSignal(""), [done, setDone] = createSignal(false);
  const task = props.task;
  function close() {
    if (busy()) { abort?.abort(); return; }
    props.onClose();
  }
  async function start() {
    if (busy() || !task?.handle) return;
    abort = new AbortController(); setBusy(true); setError(""); setDone(false); setProgress(null);
    props.onBusyChange?.(true);
    try {
      const saved = await convertTaskGifs(task.handle, { signal: abort.signal, onProgress: value => !disposed && setProgress(value) });
      if (!disposed) { setProgress({ completed: saved.length, total: saved.length, saved }); setDone(true); }
    } catch (failure) {
      if (!disposed) setError(abort.signal.aborted ? "Конвертация остановлена. Уже созданные WebM сохранены." : failure.message ?? String(failure));
    } finally { if (!disposed) setBusy(false); props.onBusyChange?.(false); }
  }
  createEffect(() => { if (dialog && !dialog.open) dialog.showModal(); });
  onCleanup(() => { disposed = true; abort?.abort(); if (dialog?.open) dialog.close(); });
  return <dialog ref={dialog} class="viewer-movie-dialog" aria-label="GIF → WebM" aria-busy={busy()}
    onCancel={event => { event.preventDefault(); close(); }}>
    <h2>GIF → WebM</h2>
    <p>{task?.name} · output3XX/demo</p>
    <p>Все GIF текущего задания → WebM · VP9 · CRF 30.</p>
    <p class="viewer-movie-note">Размеры и длительности кадров сохраняются. Исходные GIF остаются; при совпадении имени WebM добавляется числовой суффикс.</p>
    <Show when={busy()}>
      <p role="status">{progress()?.name || "Поиск GIF…"}
        {progress()?.frame ? ` · кадр ${progress().frame.completed} / ${progress().frame.total}` : ""}</p>
      <progress max={Math.max(1, progress()?.total ?? 1)} value={progress()?.completed ?? 0} />
    </Show>
    <Show when={progress()}><p role="status">Создано WebM: {progress().completed} / {progress().total}</p></Show>
    <Show when={done() && !progress()?.total}><p>В текущем задании GIF не найдены.</p></Show>
    <Show when={done() && progress()?.total}><p class="viewer-movie-saved">Все WebM сохранены в output3XX/demo.</p></Show>
    <Show when={error()}><p class="viewer-movie-error" role="alert">{error()}</p></Show>
    <div class="viewer-movie-actions">
      <Show when={!busy() && !done()}><button type="button" onClick={start}>Перезаписать все GIF в WebM</button></Show>
      <button type="button" onClick={close}>{busy() ? "Остановить" : "Закрыть"}</button>
    </div>
  </dialog>;
}
