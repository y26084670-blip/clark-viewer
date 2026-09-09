import { createEffect, createSignal, onCleanup } from "solid-js";
import { mapResultObjects, QUANTITIES } from "./resultMappings.js";

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

export function resultObjects(task, quantityKey) {
  const quantity = QUANTITIES[quantityKey];
  const metadata = task.metadata?.[quantity.file];
  if (!metadata) throw new Error(`${quantity.file}.h5 отсутствует в output3XX`);
  if (metadata.error) throw new Error(metadata.error);
  if (!metadata.steps.length) throw new Error(`${quantity.file}.h5: нет сохранённых шагов`);
  return mapResultObjects(task, quantity.file, metadata.header)
    .filter(item => !quantity.solvedOnly || item.record.targ === 0);
}

export async function readObjectFrames({ task, quantityKey, selected, time, budget }) {
  const quantity = QUANTITIES[quantityKey];
  const objects = resultObjects(task, quantityKey).filter(item => selected.includes(item.record.id));
  if (!objects.length) throw new Error("Для выбранных объектов нет этой величины");
  if (budget && objects.length > budget) throw new Error("Для показа выбрано слишком много объектов. Сократите выделение.");
  const allowance = Math.max(1, Math.floor((budget ?? Infinity) / objects.length));
  return Promise.all(objects.map(async object => {
    const every = Math.max(1, Math.ceil(object.count / allowance));
    const frame = await task.reader.read({ name: quantity.file, step: time, start: object.start, count: object.count, every });
    return { frame, record: object.record, originalCount: object.count };
  }));
}
