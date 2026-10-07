import { decodeHeader, timeDatasets, validateShape } from "./resultLayout.js";
import { resultRangeChannels } from "./resultRanges.js";

export const RANGE_BACKFILL_FILES = Object.freeze(["MH", "JE", "HS", "AS", "HV", "AV", "Q"]);
const MU0 = 4 * Math.PI * 1e-7;
const CHUNK_ROWS = 32768;

function headerFrom(handle) {
  const raw = {};
  for (const key of ["columns", "arrCount", "hasCoo", "inds1", "numbs"]) {
    const dataset = handle.get(`HEADER/${key}`);
    if (!dataset) throw new Error(`Не найден HEADER/${key}`);
    raw[key] = dataset.value;
  }
  return decodeHeader(raw);
}

function rowChannels(name, values, offset, stride) {
  const at = index => Number(values[offset + index]);
  const base = 3;
  if (stride <= base) throw new Error(`${name}.h5: строка результата слишком короткая`);
  if (name === "Q") return [at(base)];
  const first = [at(base), at(base + 1), at(base + 2)];
  const norm = v => v.every(Number.isFinite) ? Math.hypot(...v) : NaN;
  const factor = name === "AS" || name === "AV" ? MU0 : 1;
  const scaled = first.map(v => v * factor);
  const one = [...scaled, norm(scaled)];
  if (!["MH", "JE"].includes(name)) return one;
  const second = [at(base + 3), at(base + 4), at(base + 5)];
  const dot = first.every(Number.isFinite) && second.every(Number.isFinite)
    ? first[0] * second[0] + first[1] * second[1] + first[2] * second[2] : NaN;
  return name === "MH"
    ? [...first, norm(first), ...second, norm(second), dot * 0.4 * Math.PI]
    : [...first, norm(first), ...second, norm(second), dot * 1e-3];
}

function blankStats(size) {
  return {
    minimum: new Float64Array(size).fill(Infinity),
    maximum: new Float64Array(size).fill(-Infinity),
    valid: new BigInt64Array(size),
    invalid: new BigInt64Array(size),
  };
}

function finishStats(stats) {
  for (let i = 0; i < stats.valid.length; i++) {
    if (stats.valid[i] === 0n) {
      stats.minimum[i] = NaN;
      stats.maximum[i] = NaN;
    }
  }
  return stats;
}

function updateStats(stats, index, value) {
  if (Number.isFinite(value)) {
    if (value < stats.minimum[index]) stats.minimum[index] = value;
    if (value > stats.maximum[index]) stats.maximum[index] = value;
    stats.valid[index]++;
  } else {
    stats.invalid[index]++;
  }
}

function combineStats(global, step) {
  for (let i = 0; i < global.valid.length; i++) {
    if (step.valid[i] > 0n) {
      global.minimum[i] = Math.min(global.minimum[i], step.minimum[i]);
      global.maximum[i] = Math.max(global.maximum[i], step.maximum[i]);
    }
    global.valid[i] += step.valid[i];
    global.invalid[i] += step.invalid[i];
  }
}

function scalar(group, name, value, dtype = null) {
  const data = typeof value === "string" ? value
    : dtype === "<q" ? new BigInt64Array([BigInt(value)])
    : dtype === "<b" ? new Int8Array([value])
    : dtype === "<i" ? new Int32Array([value])
    : new Float64Array([value]);
  return group.create_dataset({ name, data, shape: [] , ...(dtype ? { dtype } : {}) });
}

function arrayDataset(group, name, data, shape = null, dtype = null) {
  return group.create_dataset({ name, data, ...(shape ? { shape } : {}), ...(dtype ? { dtype } : {}) });
}

function writeStats(group, stats, objectCount, channelCount) {
  const shape = [objectCount, channelCount];
  arrayDataset(group, "min", stats.minimum, shape, "<d");
  arrayDataset(group, "max", stats.maximum, shape, "<d");
  arrayDataset(group, "valid_count", stats.valid, shape, "<q");
  arrayDataset(group, "invalid_count", stats.invalid, shape, "<q");
}

/** Append HEADER/RANGES v1 to a temporary writable copy of an old result file. */
export function appendResultRanges(handle, plan, onProgress = () => {}) {
  if (handle.get("HEADER/RANGES")) throw new Error(`${plan.name}.h5 уже содержит HEADER/RANGES`);
  const header = headerFrom(handle);
  const steps = timeDatasets(handle.keys());
  const channels = resultRangeChannels(plan.name);
  const objects = plan.objectIds ?? [];
  const applicability = plan.applicability ?? [];
  if (!RANGE_BACKFILL_FILES.includes(plan.name) || !channels.length) throw new Error("Неподдерживаемое семейство результатов");
  if (objects.length !== header.numbs.length || applicability.length !== objects.length * channels.length) {
    throw new Error(`${plan.name}.h5: план объектов не совпадает с HEADER`);
  }
  if (!Number.isSafeInteger(plan.lastStep) || plan.lastStep < 0 || !Number.isFinite(plan.timeStep)
      || plan.timeStep < 0 || (plan.lastStep > 0 && plan.timeStep === 0)
      || steps.length !== plan.lastStep + 1 || steps.some((step, i) => step.index !== i)) {
    throw new Error(`${plan.name}.h5: неполные данные`);
  }
  if (new Set(objects).size !== objects.length || objects.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${plan.name}.h5: неверные идентификаторы объектов`);
  }
  const channelCount = channels.length, objectCount = objects.length, size = channelCount * objectCount;
  const global = blankStats(size), byStep = [];
  steps.forEach((step, stepOrdinal) => {
    const dataset = handle.get(step.key);
    validateShape(dataset.shape, header);
    const stats = blankStats(size);
    for (let object = 0; object < objectCount; object++) {
      const start = header.inds1[object] - 1, count = header.numbs[object];
      for (let chunkStart = 0; chunkStart < count; chunkStart += CHUNK_ROWS) {
        const rows = Math.min(CHUNK_ROWS, count - chunkStart);
        const values = dataset.slice([[start + chunkStart, start + chunkStart + rows, 1], []]);
        if (!(values instanceof Float32Array || values instanceof Float64Array)
            || values.length !== rows * header.stride) throw new Error(`${plan.name}.h5: неверная выборка шага ${step.index}`);
        for (let row = 0; row < rows; row++) {
          const rowValues = rowChannels(plan.name, values, row * header.stride, header.stride);
          if (rowValues.length !== channelCount) throw new Error(`${plan.name}.h5: число вычисленных каналов не совпадает с контрактом`);
          for (let channel = 0; channel < channelCount; channel++) {
            const index = object * channelCount + channel;
            if (applicability[index]) updateStats(stats, index, rowValues[channel]);
          }
        }
      }
    }
    finishStats(stats); combineStats(global, stats); byStep.push({ step, stats });
    onProgress({ phase: "scan", step: stepOrdinal + 1, total: steps.length });
  });
  finishStats(global);

  const headerGroup = handle.get("HEADER");
  const ranges = headerGroup.create_group("RANGES");
  scalar(ranges, "schema_version", 1, "<i");
  scalar(ranges, "quantity_definition_version", 1, "<i");
  scalar(ranges, "run_id", plan.runId);
  scalar(ranges, "object_kind", plan.objectKind);
  arrayDataset(ranges, "object_ids", BigInt64Array.from(objects, BigInt), [objectCount], "<q");
  arrayDataset(ranges, "channel_ids", channels.map(channel => channel.id), [channelCount]);
  arrayDataset(ranges, "channel_units", channels.map(channel => channel.unit), [channelCount]);
  scalar(ranges, "time_step", plan.timeStep, "<d");
  scalar(ranges, "last_step", plan.lastStep, "<q");
  const revision = steps.length;
  scalar(ranges, "data_revision", revision, "<q");
  scalar(ranges, "indexed_revision", revision, "<q");
  scalar(ranges, "state", "complete");
  const byStepGroup = ranges.create_group("by_step");
  byStep.forEach(({ step, stats }, ordinal) => {
    const group = byStepGroup.create_group(step.key);
    writeStats(group, stats, objectCount, channelCount);
    scalar(group, "time", step.index * plan.timeStep, "<d");
    scalar(group, "revision", ordinal + 1, "<q");
    scalar(group, "accepted", 1, "<b");
  });
  const globalGroup = ranges.create_group("global");
  writeStats(globalGroup, global, objectCount, channelCount);
  arrayDataset(ranges, "step_ids", BigInt64Array.from(steps, step => BigInt(step.index)), [steps.length], "<q");
  arrayDataset(ranges, "times", Float64Array.from(steps, step => step.index * plan.timeStep), [steps.length], "<d");
  handle.flush?.();
  return { steps: steps.length, objects: objectCount, channels: channelCount };
}
