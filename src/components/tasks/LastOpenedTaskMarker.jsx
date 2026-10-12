import { Show } from "solid-js";
import "./LastOpenedTaskMarker.css";

export function LastOpenedTaskMarker(props) {
  return <span class="task-last-opened-marker" role="img" aria-label={props.label} title={props.label}>
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <polygon points="2,1 11,6 2,11" fill="#ffff00" stroke="#ff0000" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
    <span class="task-last-opened-marker-fallback" aria-hidden="true">▶ </span>
  </span>;
}

// Build the button outside the select's HTML template. Its content reacts to
// history changes even when the selected project itself has not changed.
export function ProjectSelectValue(props) {
  return <button type="button" class="task-project-value">
    <Show when={props.marked}><LastOpenedTaskMarker label="Последний открытый проект" /></Show>
    {props.value || props.placeholder}
  </button>;
}
