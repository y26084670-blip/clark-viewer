import { checkReadRange, decodeHeader, timeDatasets, validateShape } from "./resultLayout.js";
import { readResultRanges } from "./resultRanges.js";

const families = {
  MH: [3, 2, true], JE: [3, 2, true], HS: [3, 1, true], AS: [3, 1, true],
  HV: [3, 1, true], AV: [3, 1, true], Q: [1, 1, true], FM: [3, 2, false], PSI: [1, 1, false],
};

// Shared by the browser worker and actual-HDF5 integration checks in Node.
export class Hdf5ResultFile {
  constructor(name, handle) {
    this.name = name; this.handle = handle;
    const raw = {};
    for (const key of ["columns", "arrCount", "hasCoo", "inds1", "numbs"]) {
      const dataset = handle.get(`HEADER/${key}`);
      if (!dataset) throw new Error(`Не найден HEADER/${key}`);
      raw[key] = dataset.value;
    }
    this.header = decodeHeader(raw);
    const family = families[name];
    if (!family || family.some((value, i) => value !== [this.header.columns, this.header.arrCount, this.header.hasCoo][i])) {
      throw new Error(`${name}.h5: HEADER не соответствует формату solver`);
    }
    this.steps = timeDatasets(handle.keys());
    this.byStep = new Map();
    this.pointCount = null;
    for (const step of this.steps) {
      if (this.byStep.has(step.index)) throw new Error("Неоднозначные номера шагов HDF5");
      const points = validateShape(handle.get(step.key).shape, this.header);
      if (this.pointCount !== null && points !== this.pointCount) {
        throw new Error(`${name}.h5: число строк меняется между сохранёнными шагами`);
      }
      this.pointCount = points;
      this.byStep.set(step.index, step.key);
    }
    this.ranges = readResultRanges(handle, { name, header: this.header, steps: this.steps });
  }
  get metadata() { return { header: this.header, steps: this.steps, pointCount: this.pointCount, ranges: this.ranges }; }
  read({ step, start, count, every = 1 }) {
    const key = this.byStep.get(step);
    if (!key) throw new Error(`${this.name}.h5: нет данных для момента ${step}`);
    const dataset = this.handle.get(key);
    const points = validateShape(dataset.shape, this.header);
    if (!Number.isSafeInteger(every) || every < 1) throw new Error("Некорректный шаг выборки");
    checkReadRange(start, count, points, this.header.stride, every);
    const values = count ? dataset.slice([[start, start + count, every], []]) : new Float64Array();
    if (!(values instanceof Float32Array || values instanceof Float64Array)) throw new Error("Ожидались данные REAL32/REAL64");
    return { values, stride: this.header.stride, start, count: values.length / this.header.stride, every };
  }
  history({ point }) {
    const stride = this.header.stride;
    checkReadRange(0, this.steps.length, this.steps.length, stride);
    const values = new Float64Array(this.steps.length * stride);
    this.steps.forEach((step, i) => values.set(this.read({ step: step.index, start: point, count: 1 }).values, i * stride));
    return { values, stride, steps: this.steps.map(step => step.index) };
  }
  integralHistory({ weights, offset }) {
    const stride = this.header.stride;
    if (!(weights instanceof Float64Array) || weights.length !== this.pointCount
        || !Number.isSafeInteger(offset) || offset < 0 || offset >= stride
        || !weights.every(Number.isFinite)) throw new Error(`${this.name}.h5: неверные веса интегрирования`);
    checkReadRange(0, weights.length, weights.length, 1);
    checkReadRange(0, this.steps.length, this.steps.length, 1);
    const values = new Float64Array(this.steps.length);
    // Работает внутри HDF5 Worker: ограниченные срезы, без массива ЭО × время.
    this.steps.forEach((step, i) => {
      let sum = 0, correction = 0;
      for (let start = 0; start < weights.length; start += 16384) {
        const count = Math.min(16384, weights.length - start);
        const frame = this.read({ step: step.index, start, count });
        for (let row = 0; row < count; row++) {
          const weight = weights[start + row];
          if (weight === 0) continue;
          const contribution = frame.values[row * stride + offset] * weight;
          if (!Number.isFinite(contribution)) throw new Error(`${this.name}.h5: нечисловые или бесконечные потери`);
          const adjusted = contribution - correction, next = sum + adjusted;
          correction = (next - sum) - adjusted;
          sum = next;
        }
      }
      if (!Number.isFinite(sum)) throw new Error(`${this.name}.h5: сумма потерь выходит за числовой диапазон`);
      values[i] = sum;
    });
    return { values, stride: 1, steps: this.steps.map(step => step.index) };
  }
  close() { this.handle.close(); }
}
