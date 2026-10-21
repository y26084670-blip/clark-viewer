import { createSignal, onCleanup, Show } from "solid-js";
import { captureProtocolMovie, protocolMoment } from "../../services/protocol/protocolCapture.js";
import "./Protocol.css";

export function ProtocolCheck(props) {
  const [error, setError] = createSignal("");
  let abort;
  onCleanup(() => abort?.abort());
  const checked = () => Boolean(props.context.protocolEntries?.[props.entryKey]);
  async function change(event) {
    if (props.context.movieBusy || props.disabled) return;
    const add = event.currentTarget.checked;
    event.currentTarget.checked = checked();
    setError("");
    if (!add) { props.context.setProtocolEntry(props.entryKey, null); return; }
    const task = props.context.task, time = props.context.time;
    const title = props.title, comment = `${protocolMoment(task, time)}${props.comment ? ` · ${props.comment}` : ""}`;
    const controller = new AbortController(); abort = controller;
    const timer = setTimeout(() => controller.abort(new Error("График не готов к снимку. Дождитесь загрузки и повторите.")), 15000);
    props.context.setProtocolBusy?.(true);
    try {
      const options = { signal: controller.signal, caption: `${title} · ${protocolMoment(task, time)}` };
      const image = props.capture ? await props.capture(options) : await captureProtocolMovie(props.adapter, options);
      controller.signal.throwIfAborted();
      if (props.context.task === task) props.context.setProtocolEntry(props.entryKey,
        { ...image, id: crypto.randomUUID(), title, comment });
    } catch (failure) { if (props.context.task === task) setError(failure.message || String(failure)); }
    finally { clearTimeout(timer); abort = null; props.context.setProtocolBusy?.(false); }
  }
  return <span class="protocol-check-wrap">
    <label class="protocol-check" title={error() || "В протокол: сохранить снимок текущего вида. Для обновления снимка снимите и снова поставьте отметку."}>
      <input type="checkbox" aria-label="В протокол" checked={checked()} disabled={props.context.movieBusy || props.disabled}
        onChange={change} /><Show when={!props.compact}>В протокол</Show>
    </label>
    <Show when={error()}><span class="protocol-check-error" role="alert">{error()}</span></Show>
  </span>;
}
