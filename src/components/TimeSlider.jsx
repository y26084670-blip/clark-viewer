import { createUniqueId } from "solid-js";

export function TimeSlider(props) {
  const id = createUniqueId();
  const time = () => (props.index ?? 0) * (props.step ?? 0);
  return <div class="time-slider">
    <label for={id}>t = {time().toLocaleString("ru-RU", { maximumSignificantDigits: 8 })} с</label>
    <input id={id} type="range" min="0" max={props.max ?? 0} step="1"
      value={props.index ?? 0} disabled={!props.max} aria-label="Текущий момент времени"
      aria-valuetext={`Шаг ${props.index ?? 0} из ${props.max ?? 0}; ${time()} с`}
      onInput={event => props.onChange(event.currentTarget.valueAsNumber)} />
    <output for={id}>{props.index ?? 0} / {props.max ?? 0}</output>
  </div>;
}
