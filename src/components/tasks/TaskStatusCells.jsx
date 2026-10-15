import { Show } from "solid-js";
import "./TaskStatusCells.css";

const labels = {
  hasSolution: "Решение получено",
  missingInput: "Нет исходных данных: отсутствует каталог input3XX",
  hasGifs: "Созданы GIF анимации",
  hasComparison: "Есть каталог протокола сравнения: comparison",
};
const protocolAction = `${labels.hasComparison}\nЩелчок — открыть все HTML-протоколы тестов`;
const failure = (status, keys) => keys.filter(key => status?.errors?.[key])
  .map(key => `Не удалось проверить: ${labels[key]} (${status.errors[key]})`).join("\n");

export function TaskStatusCells(props) {
  return <>
    <span class="task-status-cell task-status-state" title={failure(props.status, ["hasSolution", "missingInput"])}>
      <Show when={props.status?.hasSolution === true}>
        <span class="task-status-solution" title={labels.hasSolution} role="img" aria-label={labels.hasSolution}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10l4.5 5L17 5" /></svg>
        </span>
      </Show>
      <Show when={props.status?.missingInput === true}>
        <span class="task-status-missing" title={labels.missingInput} role="img" aria-label={labels.missingInput}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
        </span>
      </Show>
    </span>
    <span class="task-status-cell" title={failure(props.status, ["hasGifs"])}>
      <Show when={props.status?.hasGifs === true}>
        <span class="task-status-gif" title={labels.hasGifs} role="img" aria-label={labels.hasGifs}>GIF</span>
      </Show>
    </span>
    <span class="task-status-cell" title={failure(props.status, ["hasComparison"])}>
      <Show when={props.status?.hasComparison === true}>
        <button type="button" class="task-status-comparison task-status-protocol-button" title={protocolAction}
          aria-label={protocolAction} disabled={props.disabled || !props.onOpenProtocols}
          onClick={event => { event.stopPropagation(); props.onOpenProtocols?.(); }}
          onDblClick={event => event.stopPropagation()}>T</button>
      </Show>
    </span>
  </>;
}
