import { RESULT_LAYER_GROUPS } from "./resultLayerDefinitions.js";
import { QUANTITIES, elementLayout, regionLayout } from "./resultMappings.js";
import { readObjectFrames, resultObjects } from "./resultRequests.js";
import { scalarScene, vectorScene } from "./resultPlots.js";
import { readResultVolumeFrame, VOLUME_MAX_NODES } from "./resultVolumeRequests.js";
import { createResultVolumeProcessor } from "./resultVolumeProcessor.js";

export const RESULT_LAYER_POINT_BUDGET = 5000;

const message = error => error?.message ?? String(error);
const cancelled = () => Object.assign(new Error("Чтение слоёв результатов отменено"), { name: "AbortError" });

function emptyLayer(layer) {
  return { key: layer.key, quantityKey: layer.quantityKey, scene: null, scalarScene: null,
    volumeFields: null, sampled: false, volumeNotice: "", error: "", state: "empty" };
}

function prepareLayer(request, layer) {
  const result = emptyLayer(layer);
  const definition = RESULT_LAYER_GROUPS.find(group => group.key === layer.key);
  if (!definition || !definition.quantities.includes(layer.quantityKey)) {
    throw new Error("Недопустимая величина для группы результатов");
  }
  if (layer.quantityKey === "none") return { result: { ...result, state: "disabled" } };
  // No metadata or HDF5 access for an empty list, including a missing file.
  if (!layer.selected?.length) return { result };
  const quantity = QUANTITIES[layer.quantityKey];
  const selected = new Set(layer.selected);
  const objects = resultObjects(request.task, layer.quantityKey).filter(item => selected.has(item.record.id)
    && (layer.key === "regions" || (item.record.targ === 3) === (layer.key === "virtual")));
  if (!objects.length) return { result };
  const count = objects.reduce((sum, object) => sum + object.count, 0);
  const minimum = objects.reduce((sum, object) => {
    const layout = layer.key === "regions" ? regionLayout(object.record)
      : elementLayout(object.record, layer.key === "virtual");
    return sum + (layer.key === "regions" ? layout.copies : layout.copies.reduce((a, b) => a * b, 1));
  }, 0);
  return { result, key: layer.key, quantity, count, minimum,
    request: { task: request.task, time: request.time, quantityKey: layer.quantityKey,
      selected: objects.map(object => object.record.id) },
    volumeMode: layer.volumeMode === true && quantity.components !== 1 };
}

/** Reserve one visible point per saved image, then share unused space. If the
 * images alone exceed the common limit, keep affordable groups working and
 * report only groups that cannot fit instead of blocking every result group.
 */
export function allocateResultLayerPointBudgets(layers, budget = RESULT_LAYER_POINT_BUDGET) {
  const allocations = new Map(), errors = new Map();
  let remaining = budget;
  for (const layer of [...layers].sort((a, b) => a.minimum - b.minimum)) {
    if (layer.minimum > remaining) {
      errors.set(layer.key, `Для группы нужно не менее ${layer.minimum} узлов по числу сохранённых образов; общий предел кадра — ${budget}. Сократите выделение.`);
      continue;
    }
    allocations.set(layer.key, layer.minimum); remaining -= layer.minimum;
  }
  let active = layers.filter(layer => allocations.has(layer.key) && allocations.get(layer.key) < layer.count);
  while (remaining && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const layer of active) {
      const allowance = allocations.get(layer.key);
      const add = Math.min(share, layer.count - allowance, remaining);
      allocations.set(layer.key, allowance + add); remaining -= add;
    }
    active = active.filter(layer => allocations.get(layer.key) < layer.count);
  }
  return { allocations, errors };
}

/** One owner for the atomic three-group frame. The outer frame controller
 * serializes reads and coalesces time changes. Each active volume group owns
 * its own lazy processor, preserving its spatial plan across time frames.
 */
export function createResultLayerReader({ processorFactory = createResultVolumeProcessor } = {}) {
  const processors = new Map();
  let closed = false, active = false;
  function release(key) {
    processors.get(key)?.processor.close(); processors.delete(key);
  }
  return {
    async read(request) {
      if (closed) throw cancelled();
      if (active) throw new Error("Предыдущий кадр результатов ещё читается");
      active = true;
      try {
        const keys = new Set();
        const prepared = request.layers.map(layer => {
          try {
            if (keys.has(layer.key)) throw new Error("Группа результатов повторяется в кадре");
            keys.add(layer.key);
            return prepareLayer(request, layer);
          } catch (error) {
            return { result: { ...emptyLayer(layer), state: "error", error: message(error) } };
          }
        });
        const candidates = prepared.filter(layer => layer.request);
        const { allocations, errors } = allocateResultLayerPointBudgets(candidates);
        for (const layer of candidates) {
          if (errors.has(layer.key)) { layer.result.state = "error"; layer.result.error = errors.get(layer.key); }
        }
        const reads = candidates.filter(layer => !errors.has(layer.key));
        const volumeCount = reads.filter(layer => layer.volumeMode).reduce((sum, layer) => sum + layer.count, 0);
        const volumeDisabledReason = volumeCount > VOLUME_MAX_NODES
          ? `Объёмные слои вместе требуют ${volumeCount.toLocaleString("ru-RU")} узлов; общий предел — ${VOLUME_MAX_NODES.toLocaleString("ru-RU")}` : "";
        // This runs only after the preceding atomic frame drained. None/empty,
        // another quantity/task, or forced point fallback releases old plans.
        for (const [key, owner] of processors) {
          const next = reads.find(layer => layer.key === key && layer.volumeMode && !volumeDisabledReason);
          if (!next || owner.task !== request.task || owner.quantityKey !== next.request.quantityKey) release(key);
        }
        const loaded = await Promise.allSettled(reads.map(async layer => {
          const budget = allocations.get(layer.key);
          let value;
          if (layer.volumeMode) {
            let processor = null;
            if (!volumeDisabledReason) {
              if (!processors.has(layer.key)) processors.set(layer.key, {
                task: request.task, quantityKey: layer.request.quantityKey, processor: processorFactory(),
              });
              processor = processors.get(layer.key).processor;
            }
            value = await readResultVolumeFrame({ ...layer.request, fallbackBudget: budget, volumeDisabledReason }, null, processor);
          } else {
            const frames = await readObjectFrames({ ...layer.request, budget });
            value = { scene: layer.quantity.components === 1 ? null : vectorScene(frames, layer.quantity),
              scalarScene: layer.quantity.components === 1 ? scalarScene(frames, layer.quantity) : null,
              sampled: frames.some(item => item.frame.count < item.originalCount) };
          }
          return { ...layer.result, ...value, state: "ready" };
        }));
        if (closed) throw cancelled();
        loaded.forEach((item, index) => {
          const layer = reads[index];
          layer.result = item.status === "fulfilled" ? item.value
            : { ...layer.result, state: "error", error: message(item.reason) };
          if (item.status === "rejected") release(layer.key);
        });
        const layers = prepared.map(layer => layer.result);
        return { layers, errors: layers.filter(layer => layer.error).map(layer => ({ key: layer.key, message: layer.error })) };
      } finally { active = false; }
    },
    close() {
      closed = true;
      for (const key of processors.keys()) release(key);
    },
  };
}
