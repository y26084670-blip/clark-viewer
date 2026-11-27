import { createEffect, createSignal, onMount, onCleanup } from "solid-js";
import { loadCloudCatalogs, readZoneReport, zoneWorkspace } from "../../services/cloudExamples.js";

export function useCloudCatalogs(app, root) {
  const [catalogs, setCatalogs] = createSignal([]);
  const [error, setError] = createSignal("");
  const [zones, setZones] = createSignal(new Set());
  const controller = new AbortController();
  let zoneRevision = 0, zonePoll = 0, workspace = "";
  function stopPolling() { clearInterval(zonePoll); zonePoll = 0; }
  async function refreshZones() {
    const handle = root(), revision = ++zoneRevision;
    const [report, bound] = await Promise.all([readZoneReport(handle), zoneWorkspace(handle)]);
    if (!controller.signal.aborted && revision === zoneRevision && handle === root()) {
      setZones(report.blocked); workspace = bound;
    }
    return report.request;
  }
  function checkZones() {
    if (!workspace || root()?.cloud) return;
    const request = crypto.randomUUID();
    window.location.href = "clark://zones?" + new URLSearchParams({ workspace, request });
    stopPolling();
    const until = Date.now() + 120000;
    zonePoll = window.setInterval(async () => {
      if (await refreshZones() === request || Date.now() > until) stopPolling();
    }, 1000);
  }
  let catalogRequest;
  function refresh() {
    if (catalogRequest) return catalogRequest;
    setError("");
    catalogRequest = loadCloudCatalogs(app, { signal: controller.signal }).then(entries => {
      if (!controller.signal.aborted) setCatalogs(entries);
      return entries;
    }).catch(error => {
      if (!controller.signal.aborted) setError("Облачные примеры недоступны. " + error.message);
      return [];
    }).finally(() => { catalogRequest = null; });
    return catalogRequest;
  }
  createEffect(() => { root(); workspace = ""; stopPolling(); setZones(new Set()); void refreshZones(); });
  onMount(() => { void refresh(); window.addEventListener("focus", refreshZones); });
  onCleanup(() => { controller.abort(); stopPolling(); window.removeEventListener("focus", refreshZones); });
  return { catalogs, error, refresh, refreshZones, checkZones,
    getCatalogs: () => catalogs().length ? catalogs() : refresh(),
    value: () => root()?.cloud ? "cloud:" + root().name : root()?.name ?? "",
    blocked: (project, task) => !root()?.cloud && zones().has((project + "/" + task).normalize("NFC").toLowerCase()),
  };
}
