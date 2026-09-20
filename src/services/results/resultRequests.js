import { createEffect, createSignal, onCleanup } from "solid-js";
import { mapResultObjects, QUANTITIES, regionLayout } from "./resultMappings.js";
import { planResultSampling } from "./resultSampling.js";
import { createResultFrameController } from "./resultFrameController.js";
import { lineSeries } from "./resultPlots.js";
import { isFmm } from "./fmmCharacteristics.js";

export function useAsyncResult(source, load) {
  const [value, setValue] = createSignal(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let revision = 0;
  createEffect(() => {
    const request = source();
    const current = ++revision;
    setValue(null); setError(""); setLoading(Boolean(request));
    if (!request) return;
    Promise.resolve().then(() => load(request)).then(result => {
      if (current === revision) setValue(() => result);
    }).catch(error => {
      if (current === revision) setError(error.message ?? String(error));
    }).finally(() => { if (current === revision) setLoading(false); });
  });
  onCleanup(() => { revision++; });
  return { value, error, loading };
}

// Opt-in for 3D and line fields; other tabs keep useAsyncResult semantics.
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
  const quantity = QUANTITIES[request.quantityKey];
  if (request.allCopies) {
    const frames = await readObjectFrames(request);
    return { series: frames.flatMap(({ frame, record }) => lineSeries(frame, record, quantity,
      request.component, request.direction, { unfold: true })), skipped: [] };
  }
  const objects = resultObjects(request.task, request.quantityKey).filter(item => request.selected.includes(item.record.id));
  if (!objects.length) throw new Error("Для выбранных объектов нет этой величины");
  const available = objects.filter(item => request.copy < regionLayout(item.record).copies);
  const series = await completeReads(available.map(async object => {
    const layout = regionLayout(object.record);
    const frame = await request.task.reader.read({ name: quantity.file, step: request.time,
      start: object.start + request.copy * layout.planeCount, count: layout.planeCount });
    return lineSeries(frame, object.record, quantity, request.component, request.direction, { copy: request.copy });
  }));
  return { series: series.flat(), skipped: objects.filter(item => !available.includes(item)).map(item => `№${item.record.id}`) };
}
