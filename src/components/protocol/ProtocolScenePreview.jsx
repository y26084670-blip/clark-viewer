import { createMemo, createSignal, Show } from "solid-js";
import { newProtocol, serializeProtocol } from "../../services/protocol/protocolDocument.js";

export function ProtocolScenePreview(props) {
  const [active, setActive] = createSignal(false);
  const html = createMemo(() => active() ? serializeProtocol(newProtocol("3D-геометрия системы", [props.block])) : "");
  return <div class="protocol-scene-preview">
    <Show when={active()} fallback={<img src={props.block.poster.dataUrl} alt={props.block.title} />}>
      <iframe title="Интерактивная геометрия протокола" sandbox="allow-scripts" referrerPolicy="no-referrer" srcdoc={html()} />
    </Show>
    <button type="button" onClick={() => setActive(value => !value)}>{active() ? "Скрыть интерактивный просмотр" : "Интерактивный просмотр 3D"}</button>
  </div>;
}
