import { createMemo, createSignal, createUniqueId, For, Index, onCleanup, onMount, Show } from "solid-js";
import { useResultFrame } from "../services/results/resultRequests.js";
import { installGeometryOverlayDrag } from "../services/visualization/geometryOverlayDrag.js";
import { elementFaceCurrentsTableText } from "../services/visualization/chartTable.js";
import "./ElementFaceCurrentsDialog.css";

const directions = ["D1 · 1→2", "D2 · 1→3", "D3 · 1→5"];
const slots = ["Нач.", "Кон.", "Сред."];
const emptyGroups = [];
const seconds = new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 8 });
const displayValue = value => value === null ? "—" : Number(value.toPrecision(4)).toString().replace(".", ",");

function cellTitle(element, column, value) {
  if (column >= 9) return value === null ? "Нужны три и более слоя по каждому направлению" : `${value} А`;
  const axis = Math.floor(column / 3), layer = element.layers[axis][column % 3];
  return layer === null ? "Отдельного слоя нет" : `D${axis + 1} · слой ${layer + 1} из ${element.dimensions[axis]} · ${value} А`;
}

export function ElementFaceCurrentsDialog(props) {
  let layer, panel;
  const titleId = createUniqueId();
  const state = useResultFrame(() => ({ task: props.task, time: props.time }),
    ({ task, time }) => task.reader.elementFaceCurrents(task, time));
  const frame = createMemo(() => state().frame?.request.task === props.task ? state().frame : null);
  const groups = createMemo(() => frame()?.value ?? emptyGroups);
  const error = createMemo(() => state().requested?.time === props.time ? state().error : "");
  const [copyError, setCopyError] = createSignal("");
  async function copyTable() {
    if (error() || !groups().length) return;
    setCopyError("");
    try { await navigator.clipboard.writeText(elementFaceCurrentsTableText(groups())); }
    catch (failure) { setCopyError(`Не удалось скопировать таблицу: ${failure.message}`); }
  }
  const stepLabel = createMemo(() => {
    const requested = props.time;
    const shown = error() ? requested : frame()?.request.time ?? requested;
    const stamp = `${shown} · t = ${seconds.format(shown * props.task.general.timeStep)} с`;
    return shown === requested ? `Шаг ${stamp}` : `Показан шаг ${stamp} · запрошен шаг ${requested}`;
  });
  onMount(() => {
    const alignWorkspace = () => { layer.style.top = `${props.workspace.getBoundingClientRect().top}px`; };
    alignWorkspace();
    const observer = new ResizeObserver(alignWorkspace);
    observer.observe(props.workspace);
    let position = { x: 0, y: 0 };
    const drag = installGeometryOverlayDrag(panel, {
      getPosition: () => position, setPosition: next => { position = next; },
    });
    panel.focus({ preventScroll: true });
    onCleanup(() => { observer.disconnect(); drag.dispose(); });
  });

  return <div ref={layer} class="face-currents-layer" hidden={props.hidden}>
    <section ref={panel} class="element-face-currents" role="dialog" aria-modal="false" aria-labelledby={titleId} tabindex="-1"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      }}>
      <header>
        <div class="geometry-overlay-drag-handle" title="Перетащить окно">
          <h2 id={titleId}>Полные токи через грани</h2>
          <span class="face-currents-step" title={stepLabel()}>{stepLabel()}</span>
          <span class="face-currents-task" title={props.task.name}>{props.task.name}</span>
        </div>
        <button type="button" disabled={!groups().length || Boolean(error())}
          title="Скопировать все строки показанного шага с заголовками для Excel" onClick={copyTable}>Копировать</button>
        <button type="button" onClick={props.onClose}>Закрыть</button>
      </header>
      <Show when={copyError()}><p role="alert">{copyError()}</p></Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <div class="face-currents-scroll" tabindex="0" aria-label="Таблица полных токов" aria-busy={state().loading}>
        <table aria-label="Полные токи по элементам, А">
          <colgroup><col class="face-currents-element-col" /><col class="face-currents-image-col" /></colgroup>
          <For each={directions}>{() => <colgroup span="3" />}</For><colgroup span="2" />
          <thead><tr>
            <th rowspan="2" scope="col">ШГ</th><th rowspan="2" scope="col">Образ<br />LS / AS / PS</th>
            <For each={directions}>{name => <th colspan="3" scope="colgroup">{name}</th>}</For>
            <th colspan="2" scope="colgroup">Крайние слои</th>
          </tr><tr>
            <For each={directions}>{() => <For each={slots}>{slot => <th scope="col">{slot}</th>}</For>}</For>
            <th scope="col" title="Сумма разностей конечного и начального токов по D1, D2 и D3">Баланс</th>
            <th scope="col" title="Сумма модулей токов через отдельные площадки шести крайних сечений">Σ |ΔI|</th>
          </tr></thead>
          {/* JE groups, saved images and the eleven column slots have a fixed order for a loaded task. */}
          <Index each={groups()}>{element => <tbody>
            <Index each={element().images}>{(image, index) => <tr>
              <Show when={index === 0}><th scope="rowgroup" rowspan={element().images.length}>
                №{element().id} {element().name}<small>{element().dimensions.join(" × ")}</small>
              </th></Show>
              <th scope="row">{image().ls} / {image().as} / {image().ps}</th>
              <Index each={image().values}>{(value, col) => <td classList={{ unavailable: Boolean(error()) || value() === null }}
                title={error() || cellTitle(element(), col, value())}>{error() ? "—" : displayValue(value())}</td>}</Index>
            </tr>}</Index>
          </tbody>}</Index>
        </table>
      </div>
      <Show when={frame() && !groups().length && !error()}><p>В задании нет элементов с рассчитанными токами проводимости.</p></Show>
      <p class="face-currents-note">Токи в амперах через срединные сечения слоёв. Положительное направление — от начального слоя к конечному.</p>
    </section>
  </div>;
}
