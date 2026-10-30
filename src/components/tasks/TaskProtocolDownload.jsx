import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { scanTaskProtocolDownloads } from "../../services/protocol/protocolDownloads.js";
import { openProtocolWindow } from "../../services/protocol/protocolOpenWindow.js";
import "./TaskProtocolDownload.css";

export function useTaskProtocolDownloads(source, refreshKey) {
  const [records, setRecords] = createSignal(new Map());
  createEffect(() => {
    const tasks = source();
    refreshKey?.();
    const controller = new AbortController();
    setRecords(previous => {
      const handles = new Set(tasks.map(task => task.handle));
      const retained = new Map([...previous].filter(([handle]) => handles.has(handle)));
      return retained.size === previous.size ? previous : retained;
    });
    void scanTaskProtocolDownloads(tasks, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setRecords(previous => {
        const same = (a, b) => a && b && a.error === b.error && a.files.length === b.files.length
          && a.files.every((file, i) => file.name === b.files[i].name && file.size === b.files[i].size && file.lastModified === b.files[i].lastModified);
        const next = new Map([...value].map(([handle, record]) => [handle, same(record, previous.get(handle)) ? previous.get(handle) : record]));
        return next.size === previous.size && [...next].every(([handle, record]) => previous.get(handle) === record) ? previous : next;
      });
    }).catch(() => { /* A replaced task list cancels its scan. Per-task errors are in records. */ });
    onCleanup(() => controller.abort());
  });
  return handle => records().get(handle);
}

function details(entry) {
  const date = Number.isFinite(entry.lastModified) ? new Date(entry.lastModified).toLocaleString("ru-RU") : "дата неизвестна";
  const size = entry.size < 1024 ? `${entry.size} Б` : entry.size < 1024 ** 2
    ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(entry.size / 1024)} КиБ`
    : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(entry.size / 1024 ** 2)} МиБ`;
  return `${date} · ${size}`;
}

export function TaskProtocolDownload(props) {
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let dialog, opener, controller, disposed = false;
  const record = createMemo(() => props.record);
  const files = () => record()?.files ?? [];
  const title = () => files().length === 1 ? `Открыть протокол · ${files()[0].name}\n${details(files()[0])}`
    : `Открыть протокол · файлов: ${files().length}\nВыбрать HTML из DOCS`;
  const close = () => { dialog?.close(); opener?.focus(); };
  createEffect(() => {
    record(); props.taskHandle;
    controller?.abort(); controller = null;
    setBusy(false); setError("");
    // Refreshing metadata or changing tasks invalidates an open chooser.
    if (dialog?.open) dialog.close();
  });
  onCleanup(() => { disposed = true; controller?.abort(); });

  async function openProtocol(entry) {
    if (props.disabled || busy()) return;
    const request = controller = new AbortController();
    setBusy(true); setError("");
    try {
      await openProtocolWindow(entry, { signal: request.signal });
      if (disposed || request.signal.aborted) return;
      close();
    } catch (error) {
      if (!disposed && !request.signal.aborted) setError(`Не удалось открыть «${entry.name}»: ${error.message}`);
    } finally { if (!disposed && controller === request) setBusy(false); }
  }

  return <span class="task-protocol-download" title={record()?.error ? `Не удалось проверить протоколы: ${record().error}` : undefined}
    onClick={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()}>
    <Show when={files().length}>
      <button type="button" class="task-protocol-download-button" title={title()} aria-label={title()}
        aria-haspopup={files().length > 1 ? "dialog" : undefined} aria-busy={busy()}
        disabled={props.disabled || busy()} onClick={event => {
          opener = event.currentTarget; setError("");
          if (files().length === 1) void openProtocol(files()[0]);
          else dialog.showModal();
        }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H5v20h14V7zM14 2v5h5M12 10v8m-3-3 3 3 3-3" /></svg>
        <Show when={files().length > 1}><span class="task-protocol-download-count">{files().length}</span></Show>
      </button>
    </Show>
    <Show when={error() && !dialog?.open}><span class="task-protocol-download-error" role="alert">{error()}</span></Show>
    <dialog ref={dialog} class="task-protocol-download-dialog" aria-label={`Протоколы задания «${props.taskName}»`}
      onClose={() => opener?.focus()} onCancel={() => { controller?.abort(); setBusy(false); }}>
      <strong>Открыть протокол · {props.taskName}</strong>
      <div class="task-protocol-download-list">
        <For each={files()}>{entry => <button type="button" disabled={props.disabled || busy()}
          onClick={() => void openProtocol(entry)}><span>{entry.name}</span><small>{details(entry)}</small></button>}</For>
      </div>
      <Show when={error()}><p class="task-protocol-download-error" role="alert">{error()}</p></Show>
      <button type="button" onClick={() => { controller?.abort(); setBusy(false); close(); }}>Закрыть</button>
    </dialog>
  </span>;
}
