import { readRelativeConductivityFrames } from "./relativeConductivity.js";
import { RESULT_LAYER_GROUPS } from "./resultLayerDefinitions.js";
import { referenceResultVectorLayers } from "../visualization/resultVectorScale.js";
import { QUANTITIES, sourceRecords } from "./resultMappings.js";
import { readWorkResidualFrames } from "./workResiduals.js";
import { readObjectFrames, resultObjects } from "./resultRequests.js";
import { scalarScene, vectorScene } from "./resultPlots.js";
import { readResultVolumeFrame } from "./resultVolumeRequests.js";
import { createResultVolumeProcessor } from "./resultVolumeProcessor.js";
import { createResultStreamlineProcessor } from "./resultStreamlineProcessor.js";
import { readResultStreamlines } from "./resultStreamlineRequests.js";

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
  if (quantity.workResidual) {
    const records = sourceRecords(request.task, quantity.file).filter(record => selected.has(record.id));
    if (!records.length) return { result };
    return { result, key: layer.key, quantity, volumeMode: false,
      request: { task: request.task, quantityKey: layer.quantityKey, selected: records.map(record => record.id) } };
  }
  const objects = resultObjects(request.task, layer.quantityKey).filter(item => selected.has(item.record.id)
    && (layer.key === "regions" || (item.record.targ === 3) === (layer.key === "virtual")));
  if (!objects.length) return { result };
  return { result, key: layer.key, quantity,
    request: { task: request.task, time: request.time, quantityKey: layer.quantityKey,
      selected: objects.map(object => object.record.id) },
    volumeMode: layer.volumeMode === true };
}

/** One owner for the atomic three-group frame. The outer frame controller
 * serializes reads and coalesces time changes. Each active volume group owns
 * its own lazy processor, preserving its spatial plan across time frames.
 */
export function createResultLayerReader({ processorFactory = createResultVolumeProcessor,
  streamlineProcessorFactory = createResultStreamlineProcessor, residualReader = readWorkResidualFrames } = {}) {
  const processors = new Map();
  let streamlineProcessor = null;
  let streamlineFrame = null;
  let closed = false, active = false;
  function release(key) {
    processors.get(key)?.processor.close(); processors.delete(key);
  }
  return {
    async read(request) {
      if (closed) throw cancelled();
      let linePerformance = null;
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
        const reads = prepared.filter(layer => layer.request);
        // This runs only after the preceding atomic frame drained. None/empty,
        // another quantity/task releases old plans.
        for (const [key, owner] of processors) {
          const next = reads.find(layer => layer.key === key && layer.volumeMode);
          if (!next || owner.task !== request.task || owner.quantityKey !== next.request.quantityKey) release(key);
        }
        const loaded = await Promise.allSettled(reads.map(async layer => {
          let value;
          if (layer.volumeMode) {
            if (!processors.has(layer.key)) processors.set(layer.key, {
              task: request.task, quantityKey: layer.request.quantityKey, processor: processorFactory(),
            });
            value = await readResultVolumeFrame(layer.request, null, processors.get(layer.key).processor);
          } else {
            const frames = await (layer.quantity.workResidual ? residualReader
              : layer.quantity.relativeConductivity ? readRelativeConductivityFrames : readObjectFrames)(layer.request);
            value = { scene: layer.quantity.components === 1 ? null : vectorScene(frames, layer.quantity, request.task),
              scalarScene: layer.quantity.components === 1 ? scalarScene(frames, layer.quantity, request.task) : null,
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
        const layers = referenceResultVectorLayers(request.task, prepared.map(layer => layer.result));
        let streamlines = [];
        if (request.streamlineSeeds?.length) {
          streamlineProcessor ??= streamlineProcessorFactory();
          const method = request.streamlineMethod ?? "trilinear";
          const compatible = streamlineFrame?.task === request.task && streamlineFrame.time === request.time
            && streamlineFrame.tolerance === request.streamlineTolerance && streamlineFrame.method === method;
          const cached = compatible ? streamlineFrame.lines : new Map();
          const key = seed => JSON.stringify([seed.id, seed.quantityKey, seed.source.recordIndex,
            seed.instance.ls, seed.instance.as, seed.instance.ps, seed.node]);
          const missing = request.streamlineSeeds.filter(seed => !cached.has(key(seed)));
          const calculated = missing.length ? await readResultStreamlines({ ...request, streamlineSeeds: missing,
            onPerformance: request.performanceEnabled?.() ? profile => { linePerformance = profile; } : undefined }, streamlineProcessor) : [];
          missing.forEach(seed => {
            const line = calculated.find(item => item.id === seed.id);
            if (line && !line.error) cached.set(key(seed), line);
          });
          streamlines = request.streamlineSeeds.map(seed => cached.get(key(seed)) ?? calculated.find(item => item.id === seed.id)).filter(Boolean);
          streamlineFrame = { task: request.task, time: request.time, tolerance: request.streamlineTolerance, method,
            lines: new Map(request.streamlineSeeds.filter(seed => cached.has(key(seed))).map(seed => [key(seed), cached.get(key(seed))])) };
        } else {
          if (streamlineProcessor) { streamlineProcessor.close(); streamlineProcessor = null; }
          streamlineFrame = null;
        }
        if (closed) throw cancelled();
        return { layers, streamlines, performance: linePerformance ? { line: linePerformance } : null, errors: [
          ...layers.filter(layer => layer.error).map(layer => ({ key: layer.key, message: layer.error })),
          ...streamlines.filter(line => line.error).map(line => ({ key: `line-${line.id}`, message: line.error })),
        ] };
      } finally { active = false; }
    },
    close() {
      closed = true;
      for (const key of processors.keys()) release(key);
      streamlineProcessor?.close(); streamlineProcessor = null;
      streamlineFrame = null;
    },
  };
}
