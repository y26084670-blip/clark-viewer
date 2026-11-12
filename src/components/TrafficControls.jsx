import { For, createSignal, onCleanup } from "solid-js";
import { TRAFFIC_PERIODS, formatTrafficMegabytes, readTrafficTotal } from "../services/trafficService.js";
import "./TrafficControls.css";

const HINT = "Оценка полученного по сети трафика этого приложения в текущем браузере. " +
  "Сутки — последние 24 часа, неделя — 7 дней, месяц — 30 дней. " +
  "История накапливается с момента установки счётчика и сохраняется между запусками. " +
  "Загрузки из кеша и чтение локальных файлов не учитываются. Некоторые внешние ресурсы могут не сообщать размер.";

export function TrafficControls(props) {
  const [period, setPeriod] = createSignal("day");
  const [bytes, setBytes] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let revision = 0;
  onCleanup(() => { revision++; });

  async function showTraffic() {
    const request = ++revision;
    setBusy(true);
    setError("");
    try {
      const value = await readTrafficTotal(props.application, period());
      if (request === revision) setBytes(value);
    } catch {
      if (request === revision) {
        setBytes(null);
        setError("Не удалось прочитать историю трафика. Проверьте доступность хранилища браузера.");
      }
    } finally { if (request === revision) setBusy(false); }
  }

  return <section class="traffic-panel" aria-label={`Трафик ${props.application === "editor" ? "Editor" : "Viewer"} в этом браузере`}>
    <div class="about-separator" aria-hidden="true" />
    <div class="traffic-row" title={error() || HINT} aria-busy={busy()}>
      <button type="button" class="traffic-show-button" disabled={busy()} onClick={showTraffic}>
        Показать трафик
      </button>
      <select class="traffic-period" aria-label="Период трафика" value={period()} disabled={busy()}
        onChange={event => { setPeriod(event.currentTarget.value); setBytes(null); setError(""); }}>
        <For each={TRAFFIC_PERIODS}>{option => <option value={option.value}>{option.label}</option>}</For>
      </select>
      <label class="traffic-result">
        <input class="traffic-value" type="number" readOnly min="0" step="0.001" placeholder="—"
          aria-label="Трафик, МБ" aria-invalid={Boolean(error())}
          value={bytes() === null ? "" : formatTrafficMegabytes(bytes())} />
        <span>МБ</span>
      </label>
      <span class="traffic-status" role="status">{error()}</span>
    </div>
    <div class="about-separator" aria-hidden="true" />
  </section>;
}
