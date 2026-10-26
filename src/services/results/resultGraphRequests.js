import { QUANTITIES, elementLayout, regionLayout } from "./resultMappings.js";
import { resultObjects } from "./resultRequests.js";
import { resultSymmetryCopies, applyMatrix4ToVector } from "./resultSymmetry.js";
import { scalarAt } from "./resultPlots.js";
import { relativeConductivityBases, relativeConductivityValues } from "./relativeConductivity.js";
import { streamlineVertexOrder } from "./resultStreamlineRequests.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";
import { buildGeometryScene } from "../visualization/geometrySceneModel.js";
import { graphAxisKey, graphObjectKey, resolveGraphAxis, sameGraphObject } from "../visualization/graphAxes.js";
import { graphSurfaceDomain } from "../visualization/resultGraphField.js";
import { createResultGraphProcessor } from "./resultGraphProcessor.js";

export function graphQuantityKey(task, axis, quantities) {
  return axis.source.schemaId === "regions" ? quantities.regions
    : quantities[task.elements[axis.source.recordIndex]?.targ === 3 ? "virtual" : "elements"];
}
export const graphResultSignature = (axis, time, quantityKey, method) => JSON.stringify([graphAxisKey(axis), time, quantityKey, method]);
const abort = () => Object.assign(new Error("Построение графиков отменено."), { name: "AbortError" });
const verticesOf = primitive => {
  const flat = primitive.controlVertices ?? primitive.vertices;
  return Array.from({ length: flat.length / 3 }, (_, i) => Array.from(flat.slice(i * 3, i * 3 + 3)));
};

async function readDomain(task, model, resolved, quantityKey, time, bases) {
  const quantity = QUANTITIES[quantityKey], region = resolved.source.schemaId === "regions";
  if (!quantity || quantity.group !== (region ? "regions" : "elements")) throw new Error("Выберите величину для этого объекта.");
  const object = resultObjects(task, quantityKey).find(o => o.record.recordIndex === resolved.source.recordIndex);
  if (!object) throw new Error("Для этого объекта выбранная величина не сохранена.");
  const metadata = task.metadata[quantity.file];
  if (!metadata.steps.some(step => step.index === time)) throw new Error(`Нет сохранённого момента №${time} в ${quantity.file}.h5.`);
  const record = model[region ? "regions" : "elements"][resolved.source.recordIndex];
  const full = quantity.file === "HV" || quantity.file === "AV";
  const layout = region ? regionLayout(record) : elementLayout(record, full);
  const saved = region ? { ls: resolved.instance.ls ?? 0, as: 0, ps: 0 }
    : { ls: resolved.instance.ls ?? 0, as: layout.copies[1] === 1 ? 0 : resolved.instance.as ?? 0,
      ps: layout.copies[2] === 1 ? 0 : resolved.instance.ps ?? 0 };
  const copy = resultSymmetryCopies(model, record, quantityKey, saved)
    .find(c => sameGraphObject(resolved, { source: resolved.source, instance: c.instance }));
  if (!copy) throw new Error("Нет соответствия выбранного образа сохранённым результатам.");
  let dimensions, start, count, every;
  const line = resolved.primitive.discretization.kind === "region-line";
  if (region) {
    dimensions = [line ? 1 : layout.n1, layout.n2, 1];
    start = object.start + saved.ls * layout.planeCount;
    every = 1; count = dimensions[0] * dimensions[1];
  } else {
    dimensions = layout.dimensions;
    every = layout.copies.reduce((a, b) => a * b, 1);
    start = object.start + (saved.ls * layout.copies[1] + saved.as) * layout.copies[2] + saved.ps;
    count = (dimensions.reduce((a, b) => a * b, 1) - 1) * every + 1;
  }
  const frame = await task.reader.read({ name: quantity.file, step: time, start, count, every });
  const nodes = dimensions.reduce((a, b) => a * b, 1);
  if (frame.count !== nodes || frame.stride !== metadata.header.stride || frame.values.length !== nodes * frame.stride
    || frame.stride < (quantity.productOffsets || quantity.relativeConductivity ? 9 : quantity.offset + quantity.components))
    throw new Error("Неполная сетка результатов для графика.");
  if (quantity.relativeConductivity) frame.relativeConductivityValues = relativeConductivityValues(frame, record, await bases());
  const positions = new Float64Array(nodes * 3), vectors = new Float64Array(nodes * 3), invalid = new Uint8Array(nodes);
  for (let n = 0; n < nodes; n++) {
    positions.set(applyMatrix4ToPoint(copy.matrix, frame.values.subarray(n * frame.stride, n * frame.stride + 3)), n * 3);
    if (quantity.components === 3) vectors.set(applyMatrix4ToVector(copy.matrix,
      [0, 1, 2].map(c => frame.values[n * frame.stride + quantity.offset + c] * (quantity.factor ?? 1)), copy.sign), n * 3);
    else {
      const value = scalarAt(frame, n, quantity);
      if (Number.isNaN(value) && quantity.relativeConductivity) invalid[n] = 1;
      else if (!Number.isFinite(value)) throw new Error("Нечисловое значение результата.");
      vectors[n * 3] = invalid[n] ? 0 : value;
    }
  }
  const originalVertices = verticesOf(resolved.primitive);
  const ordered = region ? originalVertices : streamlineVertexOrder(record, full).map(i => originalVertices[i]);
  const vertices = ordered.map(p => applyMatrix4ToPoint(resolved.instance.matrix, p));
  const geometry = region ? graphSurfaceDomain(vertices, dimensions, line) : { vertices, dimensions };
  return { ...geometry, key: `${graphObjectKey(resolved)}:${quantityKey}`, positions, vectors, invalid,
    coordinateBytes: frame.values.BYTES_PER_ELEMENT };
}

/** Cache one current result per axis. Hidden plots retain the same arrays. */
export function createResultGraphReader({ processorFactory = createResultGraphProcessor, initialTask, initialResults = [] } = {}) {
  let owner = initialTask, processor, closed = false, active = false;
  const cache = new Map(initialResults.filter(g => !g.error).map(g => [g.id, g]));
  return {
    async read({ task, axes, quantities, time, method }) {
      if (closed) throw abort();
      if (active) throw new Error("Графики ещё строятся.");
      active = true;
      try {
        if (owner !== task) { cache.clear(); owner = task; }
        for (const id of cache.keys()) if (!axes.some(a => a.id === id)) cache.delete(id);
        const selections = axes.map(axis => { const quantityKey = graphQuantityKey(task, axis, quantities);
          return { axis, quantityKey, signature: graphResultSignature(axis, time, quantityKey, method) }; });
        const missing = selections.filter(s => cache.get(s.axis.id)?.signature !== s.signature);
        if (!missing.length) return selections.map(s => cache.get(s.axis.id));
        const projected = buildGeometryTimeModel(task, task.moves, time), model = projected.model, scene = buildGeometryScene(model);
        const domains = new Map(), pending = [], failed = new Map();
        let basesPromise;
        const bases = () => basesPromise ??= relativeConductivityBases(task);
        for (const selection of missing) {
          const { axis, quantityKey, signature } = selection;
          try {
            const resolved = resolveGraphAxis(scene, axis), quantity = QUANTITIES[quantityKey];
            const key = `${graphObjectKey(axis)}:${quantityKey}`;
            if (!domains.has(key)) domains.set(key, await readDomain(task, model, resolved, quantityKey, time, bases));
            if (closed) throw abort();
            pending.push({ id: axis.id, signature, key, start: resolved.start, end: resolved.end,
              quantityKey, components: quantity.components, label: quantity.label, unit: quantity.unit,
              timeIndex: time, time: time * task.general.timeStep, method });
          } catch (error) {
            if (error.name === "AbortError") throw error;
            failed.set(axis.id, { id: axis.id, signature, error: error.message }); cache.delete(axis.id);
          }
        }
        if (pending.length) {
          processor ??= processorFactory();
          const results = await processor.process({ domains: [...domains.values()], axes: pending, method });
          if (closed) throw abort();
          for (const result of results) {
            if (result.error) { failed.set(result.id, result); cache.delete(result.id); }
            else cache.set(result.id, result);
          }
        }
        return selections.map(s => failed.get(s.axis.id) ?? cache.get(s.axis.id)).filter(Boolean);
      } finally { active = false; }
    },
    close() { closed = true; processor?.close(); cache.clear(); },
  };
}
