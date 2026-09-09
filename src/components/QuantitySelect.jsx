import { For, Show } from "solid-js";
import { QUANTITIES } from "../services/results/resultMappings.js";
export function QuantitySelect(props) {
  return <>
    <label>Величина <select value={props.value} onChange={event => props.onChange(event.currentTarget.value)}>
      <For each={props.options}>{key => <option value={key}>{QUANTITIES[key].label}</option>}</For>
    </select></label>
    <Show when={props.onComponentChange && QUANTITIES[props.value].components === 3}>
      <label>Компонента <select value={props.component} onChange={event => props.onComponentChange(event.currentTarget.value)}>
        <option value="norm">Модуль</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option>
      </select></label>
    </Show>
    <span class="unit-label">{QUANTITIES[props.value].unit}</span>
  </>;
}
