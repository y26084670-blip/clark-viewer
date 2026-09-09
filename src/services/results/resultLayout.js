// Port of solver/src/vsolver/01_ioRes.jl: resWrite and decodeResData.
// HDF5.jl writes a Julia [components, points] matrix as [points, components].
export const RESULT_FILES = ["MH", "JE", "HS", "AS", "HV", "AV", "Q", "FM", "PSI"];

export function safeInteger(value, label, minimum = 0) {
  const scalar = ArrayBuffer.isView(value) || Array.isArray(value) ? value[0] : value;
  const number = Number(scalar);
  if (!Number.isSafeInteger(number) || number < minimum
      || (typeof scalar === "bigint" && BigInt(number) !== scalar)) {
    throw new Error(`${label}: недопустимое целое значение`);
  }
  return number;
}

export function decodeHeader(header) {
  const columns = safeInteger(header.columns, "HEADER/columns", 1);
  const arrCount = safeInteger(header.arrCount, "HEADER/arrCount");
  const hasCooNumber = safeInteger(header.hasCoo, "HEADER/hasCoo");
  if (hasCooNumber > 1) throw new Error("HEADER/hasCoo должен быть 0 или 1");
  const inds1 = Array.from(header.inds1 ?? [], x => safeInteger(x, "HEADER/inds1", 1));
  const numbs = Array.from(header.numbs ?? [], x => safeInteger(x, "HEADER/numbs"));
  if (inds1.length !== numbs.length) throw new Error("HEADER: размеры inds1 и numbs различаются");
  let next = 1;
  inds1.forEach((start, i) => {
    if (start !== next) throw new Error("HEADER: нарушена последовательность диапазонов объектов");
    next = safeInteger(next + numbs[i], "HEADER: число точек", 1);
  });
  const hasCoo = hasCooNumber === 1;
  return { columns, arrCount, hasCoo, inds1, numbs,
    stride: safeInteger((hasCoo ? 3 : 0) + columns * arrCount, "Ширина строки", 1) };
}

export function validateShape(shape, header) {
  if (!Array.isArray(shape) || shape.length !== 2 || shape[1] !== header.stride) {
    throw new Error(`Неверная форма HDF5: ${shape?.join("×")}; ожидается N×${header.stride}`);
  }
  const points = safeInteger(shape[0], "Число точек");
  const total = header.numbs.reduce((a, b) => a + b, 0);
  if (header.numbs.length && points !== total) throw new Error("Число точек шага не соответствует HEADER");
  return points;
}

export function timeDatasets(keys) {
  return keys.filter(key => /^\d+$/.test(key))
    .map(key => ({ key, index: safeInteger(key, "Номер шага") }))
    .sort((a, b) => a.index - b.index);
}

export function checkReadRange(start, count, pointCount, stride, every = 1) {
  safeInteger(start, "Начало диапазона");
  safeInteger(count, "Размер диапазона");
  if (start + count > pointCount) throw new Error("Диапазон выходит за границы данных");
  if (Math.ceil(count / every) * stride * 8 > 64 * 1024 * 1024) {
    throw new Error("Выборка превышает 64 МБ. Выберите меньше объектов или более узкий диапазон.");
  }
}
