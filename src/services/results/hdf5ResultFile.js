import { checkReadRange, decodeHeader, timeDatasets, validateShape } from "./resultLayout.js";

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
    for (const step of this.steps) {
      if (this.byStep.has(step.index)) throw new Error("Неоднозначные номера шагов HDF5");
      validateShape(handle.get(step.key).shape, this.header);
      this.byStep.set(step.index, step.key);
    }
  }
  get metadata() { return { header: this.header, steps: this.steps }; }
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
  close() { this.handle.close(); }
}
