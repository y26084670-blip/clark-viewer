import { createUniqueId, For, onMount, Show } from "solid-js";
import { useResultFrame } from "../services/results/resultRequests.js";
import { TimeSlider } from "./TimeSlider.jsx";
import "./ElementFaceCurrentsDialog.css";

const directions = ["D1 · 1→2", "D2 · 1→3", "D3 · 1→5"];
const slots = ["Нач.", "Кон.", "Сред."];
const displayValue = value => value === null ? "—" : Number(value.toPrecision(7)).toString().replace(".", ",");

function cellTitle(element, column, value) {
  if (column >= 9) return value === null ? "Нужны три и более слоя по каждому направлению" : `${value} А`;
  const axis = Math.floor(column / 3), layer = element.layers[axis][column % 3];
  return layer === null ? "Отдельного слоя нет" : `D${axis + 1} · слой ${layer + 1} из ${element.dimensions[axis]} · ${value} А`;
}

export function ElementFaceCurrentsDialog(props) {
  let dialog;
  const titleId = createUniqueId();
  const state = useResultFrame(() => ({ task: props.task, time: props.time }),
    ({ task, time }) => task.reader.elementFaceCurrents(task, time));
  const currentFrame = () => {
    const { frame, error, loading } = state();
    return !error && !loading && frame?.request.task === props.task && frame.request.time === props.time ? frame.value : null;
  };
  onMount(() => dialog.showModal());

  return <dialog ref={dialog} class="element-face-currents" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); props.onClose(); }}>
    <header>
      <div><h2 id={titleId}>Полные токи через грани</h2><span>{props.task.name}</span></div>
      <button type="button" autofocus onClick={props.onClose}>Закрыть</button>
    </header>
    <TimeSlider index={props.time} step={props.task.general.timeStep} max={props.task.general.countTimeSteps}
      onChange={props.onTimeChange} />
    <p>Токи в амперах через срединные сечения слоёв. Положительное направление — от начального слоя к конечному.</p>
    <Show when={state().loading}><p role="status">Расчёт токов…</p></Show>
    <Show when={state().error}><p role="alert">{state().error}</p></Show>
    <Show when={currentFrame()}>{groups => <>
      <Show when={groups().length} fallback={<p>В задании нет элементов с рассчитанными токами проводимости.</p>}>
        <div class="face-currents-scroll" tabindex="0" aria-label="Таблица полных токов">
          <table aria-label="Полные токи по элементам, А">
            <thead><tr>
              <th rowspan="2" scope="col">ШГ</th><th rowspan="2" scope="col">Образ<br />LS / AS / PS</th>
              <For each={directions}>{name => <th colspan="3" scope="colgroup">{name}</th>}</For>
              <th colspan="2" scope="colgroup">Крайние слои</th>
            </tr><tr>
              <For each={directions}>{() => <For each={slots}>{slot => <th scope="col">{slot}</th>}</For>}</For>
              <th scope="col" title="Сумма разностей конечного и начального токов по D1, D2 и D3">Баланс</th>
              <th scope="col" title="Сумма модулей токов через отдельные площадки шести крайних сечений">Σ |ΔI|</th>
            </tr></thead>
            <For each={groups()}>{element => <tbody>
              <For each={element.images}>{(image, index) => <tr>
                <Show when={index() === 0}><th scope="rowgroup" rowspan={element.images.length}>
                  №{element.id} {element.name}<small>{element.dimensions.join(" × ")}</small>
                </th></Show>
                <th scope="row">{image.ls} / {image.as} / {image.ps}</th>
                <For each={image.values}>{(value, col) => <td classList={{ "unavailable": value === null }}
                  title={cellTitle(element, col(), value)}>{displayValue(value)}</td>}</For>
              </tr>}</For>
            </tbody>}</For>
          </table>
        </div>
        <p class="face-currents-note">Баланс = Σ(кон. − нач.). Для Σ |ΔI| модуль берётся по каждой площадке. Оба итога доступны от трёх слоёв по каждой оси.</p>
      </Show>
    </>}</Show>
  </dialog>;
}
