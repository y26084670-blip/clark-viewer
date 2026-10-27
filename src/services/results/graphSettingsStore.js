import { graphSliceCount } from "../visualization/resultGraphField.js";
import { QUANTITIES } from "./resultMappings.js";
import { RESULT_SCALAR_PALETTES } from "../visualization/resultScalarColors.js";

export const GRAPH_SETTINGS_FILE = "clark.viewer-graphs.json";
export const GRAPH_VIEW_DEFAULTS = Object.freeze({ resultVectorScale: 1, resultPalette: "Rainbow",
  resultElementsQuantity: "M", resultRegionsQuantity: "none", resultVirtualQuantity: "none",
  elementsMode: "all", regionsMode: "all", showLocalSymmetry: true, showAxialSymmetry: true,
  showPeriodicSymmetry: true, showMirrorSymmetry: true });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const validId = n => Number.isSafeInteger(n) && n > 0;

export function normalizeGraphChartView(view = {}) {
  const limits = Object.fromEntries(["xMin", "xMax", "yMin", "yMax"].filter(k => Number.isFinite(view.limits?.[k])).map(k => [k, view.limits[k]]));
  for (const axis of ["x", "y"]) if (!(limits[`${axis}Min`] < limits[`${axis}Max`])) { delete limits[`${axis}Min`]; delete limits[`${axis}Max`]; }
  const fraction = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  return { autoScale: view.autoScale !== false, showLegend: view.showLegend !== false, limits,
    legendPosition: view.legendPosition ? { x: fraction(view.legendPosition.x), y: fraction(view.legendPosition.y) } : { x: 1, y: 0 },
    hidden: Array.isArray(view.hidden) ? view.hidden.filter(k => ["X", "Y", "Z", "scalar"].includes(k)) : [] };
}

export function normalizeGraphSettings(value, task) {
  if (!value || value.version !== 1 || !value.settings || typeof value.settings !== "object") throw new Error("Неизвестный формат настроек графиков; файл оставлен без изменений.");
  const s = value.settings;
  if (![s.slices ?? [], s.profiles ?? []].every(a => Array.isArray(a) && a.length <= 10000)) throw new Error("Некорректная коллекция графиков; файл оставлен без изменений.");
  const sliceIds = new Set(), slices = (s.slices ?? []).filter(p => {
    if (!p || !validId(p.id) || sliceIds.has(p.id) || !integer(p.recordIndex) || ![0, 1, 2].includes(p.direction)
      || !validId(p.discrete) || p.discrete > graphSliceCount(task.elements?.[p.recordIndex], p.direction) || ![0, 1, 2].includes(p.component)) return false;
    sliceIds.add(p.id); return true;
  }).map(({ id, recordIndex, direction, discrete, component }) => ({ id, recordIndex, direction, discrete, component }));
  const profileIds = new Set(), profiles = (s.profiles ?? []).flatMap(p => {
    if (!p || !validId(p.id) || profileIds.has(p.id) || ![0, 1].includes(p.direction) || !integer(p.index) || typeof p.instanceKey !== "string") return [];
    const slice = slices.find(g => g.id === p.graphId), region = typeof p.graphId === "string" && /^region:\d+$/.test(p.graphId) ? Number(p.graphId.slice(7)) : null;
    const recordIndex = slice?.recordIndex ?? region, schema = slice ? "elements" : "regions";
    if (recordIndex == null || !task[schema]?.[recordIndex] || !p.instanceKey.startsWith(`${schema}:${recordIndex}:`)) return [];
    const record = task[schema][recordIndex], counts = slice ? [0, 1, 2].filter(d => d !== slice.direction).map(d => graphSliceCount(record, d))
      : record.dp?.slice(0, 2).map(n => Number(Array.isArray(n) ? n[0] : n));
    if (!(counts?.[1 - p.direction] > p.index)) return [];
    profileIds.add(p.id);
    return [{ id: p.id, graphId: p.graphId, instanceKey: p.instanceKey, surfaceComponent: region !== null && [0, 1, 2].includes(p.surfaceComponent) ? p.surfaceComponent : null,
      direction: p.direction, index: p.index, view: normalizeGraphChartView(p.view) }];
  });
  const view = {};
  for (const [key, initial] of Object.entries(GRAPH_VIEW_DEFAULTS)) {
    const v = s.view?.[key];
    if (typeof initial === "boolean" && typeof v === "boolean") view[key] = v;
    if (key === "resultVectorScale" && Number.isFinite(v) && v >= .01 && v <= 1000) view[key] = v;
    if (key === "resultPalette" && RESULT_SCALAR_PALETTES.includes(v)) view[key] = v;
    if (key.endsWith("Mode") && ["all", "selected", "exceptSelected", "none"].includes(v)) view[key] = v;
    if (key.endsWith("Quantity") && (v === "none" || QUANTITIES[v]?.group === (key === "resultRegionsQuantity" ? "regions" : "elements"))) view[key] = v;
  }
  const selections = Object.fromEntries(["elements", "regions"].map(key => [key,
    Array.isArray(s.selections?.[key]) ? s.selections[key].filter(id => task[key]?.some(r => r.id === id)) : undefined]));
  return { only: s.only === true, areas: s.areas === true, showSlices: s.showSlices === true, slices, profiles, view, selections,
    active: sliceIds.has(s.active) ? s.active : slices.at(-1)?.id ?? null,
    activeProfile: profileIds.has(s.activeProfile) ? s.activeProfile : profiles.at(-1)?.id ?? null,
    expandedProfile: profileIds.has(s.expandedProfile) ? s.expandedProfile : null };
}

const queues = new WeakMap();
/** Coalesced atomic writes, serialized across tab remounts. Unknown files are never overwritten. */
export function createGraphSettingsStore(task, { onNotice = () => {}, delay = 120 } = {}) {
  const directory = task?.handle;
  let pending, timer, disposed = false, writable = !!directory, lastSaved;
  const notice = text => { if (!disposed) onNotice(text); };
  const ready = (async () => {
    if (!directory) return null;
    await queues.get(directory);
    try {
      const file = await (await directory.getFileHandle(GRAPH_SETTINGS_FILE)).getFile();
      if (file.size > 2 * 1024 * 1024) throw new Error("Файл настроек графиков слишком велик; он оставлен без изменений.");
      return normalizeGraphSettings(JSON.parse(await file.text()), task);
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      writable = false; notice(`Автосохранение графиков недоступно: ${error.message}`); return null;
    }
  })();
  function flush() {
    clearTimeout(timer);
    if (!pending) return queues.get(directory) ?? Promise.resolve();
    const text = pending; pending = null;
    const write = async () => {
      await ready;
      if (!writable) { if (!directory) notice("Настройки графиков сохраняются только до закрытия страницы: каталог задания недоступен."); return; }
      let stream;
      try {
        stream = await (await directory.getFileHandle(GRAPH_SETTINGS_FILE, { create: true })).createWritable();
        await stream.write(text); await stream.close(); lastSaved = text; notice("");
      } catch (error) {
        try { await stream?.abort(); } catch { /* Already closed. */ }
        notice(`Не удалось сохранить графики: ${error.message}`);
      }
    };
    const work = (queues.get(directory) ?? Promise.resolve()).then(write, write);
    if (directory) queues.set(directory, work);
    return work;
  }
  return { ready, flush,
    save(settings) {
      if (disposed) return;
      const text = JSON.stringify({ version: 1, settings }, null, 2) + "\n";
      if (text === pending || text === lastSaved) return;
      pending = text; clearTimeout(timer); timer = setTimeout(flush, delay);
    },
    dispose() { const work = flush(); disposed = true; return work; },
  };
}
