import { QUANTITIES, elementLayout, regionLayout } from "./resultMappings.js";
import { resultObjects } from "./resultRequests.js";
import { resultSymmetryCopies } from "./resultSymmetry.js";
import { scalarAt } from "./resultPlots.js";
import { relativeConductivityBases, relativeConductivityValues } from "./relativeConductivity.js";
import { streamlineVertexOrder } from "./resultStreamlineRequests.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";
import { buildGeometryScene } from "../visualization/geometrySceneModel.js";
import { createResultGraphProcessor } from "./resultGraphProcessor.js";

export function graphQuantityKey(task, slice, quantities) {
  return quantities[task?.elements?.[slice.recordIndex]?.targ === 3 ? "virtual" : "elements"];
}
export const graphRequestKey = request => JSON.stringify([request.regions, request.slices, request.quantities]);
const abort = () => Object.assign(new Error("Построение графиков отменено."), { name: "AbortError" });
const verticesOf = primitive => {
  const flat = primitive.controlVertices ?? primitive.vertices;
  return Array.from({ length: flat.length / 3 }, (_, i) => Array.from(flat.slice(i * 3, i * 3 + 3)));
};

export function createResultGraphReader({ processorFactory = createResultGraphProcessor } = {}) {
  let owner, currentTime, processor, closed = false, active = false;
  const domains = new Map(), references = new Map();
  async function loadDomains(task, model, scene, source, quantityKey, time, bases) {
    const cacheKey = `${source.schemaId}:${source.recordIndex}:${quantityKey}`;
    if (domains.has(cacheKey)) return domains.get(cacheKey);
    const quantity = QUANTITIES[quantityKey], region = source.schemaId === "regions";
    if (!quantity || quantity.group !== source.schemaId) throw new Error("Выберите величину для этого объекта.");
    const object = resultObjects(task, quantityKey).find(o => o.record.recordIndex === source.recordIndex);
    if (!object) throw new Error("Для этого объекта выбранная величина не сохранена.");
    const metadata = task.metadata[quantity.file];
    if (!metadata.steps.some(step => step.index === time)) throw new Error(`Нет сохранённого момента №${time} в ${quantity.file}.h5.`);
    const primitive = scene.primitives.find(p => p.source.schemaId === source.schemaId && p.source.recordIndex === source.recordIndex);
    if (!primitive) throw new Error("Геометрия объекта недоступна.");
    const record = model[source.schemaId][source.recordIndex], full = ["HV", "AV"].includes(quantity.file);
    const layout = region ? regionLayout(record) : elementLayout(record, full);
    const dimensions = region ? [layout.n1, layout.n2, 1] : layout.dimensions;
    const copies = region ? [layout.copies, 1, 1] : layout.copies, copyCount = copies.reduce((a, b) => a * b, 1);
    const nodes = dimensions.reduce((a, b) => a * b, 1);
    const frame = await task.reader.read({ name: quantity.file, step: time, start: object.start, count: object.count, every: 1 });
    if (closed) throw abort();
    if (frame.count !== nodes * copyCount || frame.stride !== metadata.header.stride || frame.values.length !== frame.count * frame.stride
      || frame.stride < (quantity.productOffsets || quantity.relativeConductivity ? 9 : quantity.offset + quantity.components)) throw new Error("Неполная сетка результатов для графика.");
    if (quantity.relativeConductivity) frame.relativeConductivityValues = relativeConductivityValues(frame, record, await bases());
    const original = verticesOf(primitive), ordered = region ? original : streamlineVertexOrder(record, full).map(i => original[i]), result = [];
    for (let ls = 0; ls < copies[0]; ls++) for (let az = 0; az < copies[1]; az++) for (let ps = 0; ps < copies[2]; ps++) {
      const instance = { ls, as: az, ps }, copy = (ls * copies[1] + az) * copies[2] + ps;
      const image = primitive.instances.find(i => i.ls === ls && (i.as ?? 0) === az && (i.ps ?? 0) === ps && !i.mirrorX && !i.mirrorY);
      if (!image) throw new Error("Сохранённый образ отсутствует в геометрии.");
      const positions = new Float64Array(nodes * 3), vectors = new Float64Array(nodes * 3), invalid = new Uint8Array(nodes);
      for (let n = 0; n < nodes; n++) {
        const row = region ? ls * nodes + n : n * copyCount + copy;
        positions.set(frame.values.subarray(row * frame.stride, row * frame.stride + 3), n * 3);
        if (quantity.components === 3) for (let c = 0; c < 3; c++) vectors[n * 3 + c] = frame.values[row * frame.stride + quantity.offset + c] * (quantity.factor ?? 1);
        else {
          const value = scalarAt(frame, row, quantity);
          if (Number.isNaN(value) && quantity.relativeConductivity) invalid[n] = 1;
          else if (!Number.isFinite(value)) throw new Error("Нечисловое значение результата.");
          vectors[n * 3] = invalid[n] ? 0 : value;
        }
      }
      if (!positions.every(Number.isFinite) || !vectors.every(Number.isFinite)) throw new Error("Нечисловые координаты или значения результата.");
      result.push({ key: `${cacheKey}:${ls}:${az}:${ps}`, source, dimensions, positions, vectors, invalid,
        vertices: ordered.map(p => applyMatrix4ToPoint(image.matrix, p)),
        geometryVertices: original.map(p => applyMatrix4ToPoint(image.matrix, p)), geometryDimensions: primitive.discretization.counts,
        coordinateBytes: frame.values.BYTES_PER_ELEMENT, copies: resultSymmetryCopies(model, record, quantityKey, instance) });
    }
    domains.set(cacheKey, result); return result;
  }
  return {
    async read(request) {
      if (closed) throw abort();
      if (active) throw new Error("Графики ещё строятся.");
      active = true;
      try {
        const { task, time, slices = [], regions = [], quantities } = request;
        if (owner !== task) { domains.clear(); references.clear(); owner = task; }
        if (currentTime !== time) { domains.clear(); currentTime = time; }
        if (!slices.length && !regions.length) return { graphs: [], errors: [] };
        const { model } = buildGeometryTimeModel(task, task.moves, time), scene = buildGeometryScene(model);
        const wanted = [
          ...regions.map(recordIndex => ({ id: `region:${recordIndex}`, kind: "region", source: { schemaId: "regions", recordIndex }, quantityKey: quantities.regions })),
          ...slices.map(slice => ({ ...slice, kind: "slice", source: { schemaId: "elements", recordIndex: slice.recordIndex }, quantityKey: graphQuantityKey(task, slice, quantities) })),
        ];
        const input = new Map(), graphs = [], errors = [];
        let basesPromise; const bases = () => basesPromise ??= relativeConductivityBases(task);
        for (const descriptor of wanted) {
          try {
            const loaded = await loadDomains(task, model, scene, descriptor.source, descriptor.quantityKey, time, bases);
            if (closed) throw abort();
            loaded.forEach(domain => input.set(domain.key, domain));
            const q = QUANTITIES[descriptor.quantityKey], record = model[descriptor.source.schemaId][descriptor.source.recordIndex];
            graphs.push({ ...descriptor, source: { ...descriptor.source, name: record.name }, domainKeys: loaded.map(d => d.key),
              label: q.label, unit: q.unit, components: q.components, timeIndex: time, time: time * task.general.timeStep });
          } catch (error) { if (error.name === "AbortError") throw error; errors.push({ id: descriptor.id, message: error.message }); }
        }
        const results = graphs.length ? await (processor ??= processorFactory()).process({ domains: [...input.values()], graphs }) : [];
        if (closed) throw abort();
        for (const graph of results) {
          if (graph.error) { errors.push({ id: graph.id, message: graph.error }); continue; }
          if (!references.has(graph.quantityKey) && graph.absoluteMaximum > 0) references.set(graph.quantityKey, graph.absoluteMaximum);
          graph.referenceMaximum = references.get(graph.quantityKey) ?? 1;
        }
        // Retain only the current quantities; direction/component edits reuse full grids.
        const used = new Set(wanted.map(g => `${g.source.schemaId}:${g.source.recordIndex}:${g.quantityKey}`));
        for (const key of domains.keys()) if (!used.has(key)) domains.delete(key);
        return { graphs: results.filter(g => !g.error), errors };
      } finally { active = false; }
    },
    close() { closed = true; processor?.close(); domains.clear(); references.clear(); },
  };
}
