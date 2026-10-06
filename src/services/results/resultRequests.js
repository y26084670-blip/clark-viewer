import { createEffect, createSignal, onCleanup } from "solid-js";
import { mapResultObjects, QUANTITIES, regionLayout } from "./resultMappings.js";
import { planResultSampling } from "./resultSampling.js";
import { createResultFrameController } from "./resultFrameController.js";
import { regionSurfaceGrid } from "./resultPlots.js";
import { lineComponentSeries, normalizeFieldLineComponents } from "./fieldLineComponents.js";
import { isFmm } from "./fmmCharacteristics.js";
import { OBJECT_VISIBILITY_MODES } from "../visualization/geometryRenderFilters.js";

// The 3D lists use one-based record IDs; scene filters use zero-based indices.
// Read excluded-list complements before building a scene, otherwise the display
// filter could only hide selected results and have no remaining rows to show.
export function resultDisplaySelection(records = [], selected = [], mode) {
  if (mode !== OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED) return selected;
  const excluded = new Set(selected);
  return records.filter(record => !excluded.has(record.id)).map(record => record.id);
}

export function useAsyncResult(source, load) {
  const [state, setState] = createSignal({ requested: null, frame: null, loading: false, error: "" });
  let revision = 0;
  createEffect(() => {
    const request = source();
    const current = ++revision;
    setState({ requested: request, frame: null, loading: Boolean(request), error: "" });
    if (!request) return;
    Promise.resolve().then(() => load(request)).then(result => {
      if (current === revision) setState({ requested: request, frame: { request, value: result }, loading: false, error: "" });
    }).catch(error => {
      if (current === revision) setState({ requested: request, frame: null, loading: false, error: error.message ?? String(error) });
    });
  });
  onCleanup(() => { revision++; });
  // Request identity is required by deterministic capture: loading=false alone
  // can describe the previous step before the new reactive effect has started.
  return { value: () => state().frame?.value ?? null, error: () => state().error,
    loading: () => state().loading, state };
}

// Opt-in for 3D, line and surface fields; other tabs keep useAsyncResult semantics.
export function useResultFrame(source, load) {
  const [state, setState] = createSignal({ frame: null, requested: null, loading: false, error: "" });
  const controller = createResultFrameController({ load, publish: setState });
  createEffect(() => controller.request(source()));
  onCleanup(() => controller.close());
  return state;
}

// Drain every slice of a frame, including when one slice fails. Otherwise a
// rejected Promise.all can leave old reads queued while the next frame starts.
async function completeReads(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

export function resultObjects(task, quantityKey) {
  const quantity = QUANTITIES[quantityKey];
  const metadata = task.metadata?.[quantity.file];
  if (!metadata) throw new Error(`${quantity.file}.h5 отсутствует в output3XX`);
  if (metadata.error) throw new Error(metadata.error);
  if (!metadata.steps.length) throw new Error(`${quantity.file}.h5: нет сохранённых шагов`);
  return mapResultObjects(task, quantity.file, metadata.header)
    .filter(item => (!quantity.solvedOnly || item.record.targ === 0) && (!quantity.fmmOnly || isFmm(item.record)));
}

export async function readObjectFrames({ task, quantityKey, selected, time, budget }) {
  const quantity = QUANTITIES[quantityKey];
  const objects = resultObjects(task, quantityKey).filter(item => selected.includes(item.record.id));
  if (!objects.length) throw new Error("Для выбранных объектов нет этой величины");
  const plans = budget == null ? objects.map(object => ({ object, ranges: [{ start: object.start, count: object.count, every: 1 }] }))
    : planResultSampling(objects, quantity, budget);
  return completeReads(plans.map(async ({ object, ranges }) => {
    const parts = await completeReads(ranges.map(range => task.reader.read({ name: quantity.file, step: time, ...range })));
    let frame = parts[0];
    if (ranges.length > 1 || frame.every !== 1) {
      const count = parts.reduce((sum, part) => sum + part.count, 0);
      const stride = frame.stride;
      const values = new frame.values.constructor(count * stride);
      const rowIndices = new Float64Array(count);
      let offset = 0;
      parts.forEach((part, index) => {
        if (part.stride !== stride || part.values.constructor !== values.constructor) throw new Error("Несогласованный формат выборок HDF5");
        values.set(part.values, offset * stride);
        const range = ranges[index];
        for (let row = 0; row < part.count; row++) rowIndices[offset + row] = range.start - object.start + row * range.every;
        offset += part.count;
      });
      frame = { values, rowIndices, stride, count, start: object.start, every: 1 };
    }
    return { frame, record: object.record, originalCount: object.count };
  }));
}

// Keep all slices inside one controller operation, including a failed slice.
export async function readLineFrame(request) {
  const components = normalizeFieldLineComponents(request.components ?? [request.component ?? "norm"]);
  if (!components.length) return { series: [], skipped: [] };
  const quantity = QUANTITIES[request.quantityKey];
  if (request.allCopies) {
    const frames = await readObjectFrames(request);
    return { series: frames.flatMap(({ frame, record }) => lineComponentSeries(frame, record, request.quantityKey,
      components, request.direction, { unfold: true })), skipped: [] };
  }
  const objects = resultObjects(request.task, request.quantityKey).filter(item => request.selected.includes(item.record.id));
  if (!objects.length) throw new Error("Для выбранных объектов нет этой величины");
  const available = objects.filter(item => request.copy < regionLayout(item.record).copies);
  const series = await completeReads(available.map(async object => {
    const layout = regionLayout(object.record);
    const frame = await request.task.reader.read({ name: quantity.file, step: request.time,
      start: object.start + request.copy * layout.planeCount, count: layout.planeCount });
    return lineComponentSeries(frame, object.record, request.quantityKey, components, request.direction, { copy: request.copy });
  }));
  return { series: series.flat(), skipped: objects.filter(item => !available.includes(item)).map(item => `№${item.record.id}`) };
}

export async function readSurfaceFrame(request) {
  const quantity = QUANTITIES[request.quantityKey];
  const object = resultObjects(request.task, request.quantityKey).find(item => item.record.id === request.selected[0]);
  if (!object) throw new Error("Для выбранной площадки нет этой величины");
  const layout = regionLayout(object.record);
  if (!Number.isSafeInteger(request.copy) || request.copy < 0 || request.copy >= layout.copies) throw new Error("Неверный номер LS");
  const frame = await request.task.reader.read({ name: quantity.file, step: request.time,
    start: object.start + request.copy * layout.planeCount, count: layout.planeCount });
  return regionSurfaceGrid(frame, object.record, quantity, request.component, request.copy);
}
