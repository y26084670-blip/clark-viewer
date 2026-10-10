// Visual reconstruction of saved vector components; no volume-average or
// divergence constraint is implied. Domains and material seams stay separate.
const caches = new WeakMap();
const FIT_CACHE_LIMIT = 512;
const BLEND_RADIUS = 1.5;
const dot = (a, b) => a.reduce((sum, value, k) => sum + value * b[k], 0);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const subtract = (a, b) => a.map((value, k) => value - b[k]);
const finiteVector = vector => vector.length === 3 && vector.every(Number.isFinite);
const rankNotice = "Квадратичная реконструкция: недостаточно независимых данных";
const linearNotice = "Квадратичная реконструкция: используется линейный порядок";
const cubicNotice = "Трикубическая реконструкция: пониженный порядок на редкой сетке";

function cacheFor(domain) {
  let cache = caches.get(domain);
  if (!cache) {
    cache = { fits: new Map(), cubic: null, quadratic: null };
    caches.set(domain, cache);
  }
  return cache;
}
function indexOf(dimensions, indices) {
  return (indices[0] * dimensions[1] + indices[1]) * dimensions[2] + indices[2];
}
function pointAt(domain, u) {
  const vertices = domain.localVertices ?? domain.vertices.map(point => subtract(point, domain.vertices[0]));
  const origin = domain.origin ?? domain.vertices[0];
  const local = [0, 0, 0], jacobian = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let n = 0; n < 8; n++) {
    const factors = u.map((value, axis) => (n >> axis) & 1 ? value : 1 - value);
    for (let component = 0; component < 3; component++) {
      local[component] += vertices[n][component] * factors[0] * factors[1] * factors[2];
      for (let axis = 0; axis < 3; axis++) {
        jacobian[axis][component] += vertices[n][component] * ((n >> axis) & 1 ? 1 : -1)
          * factors[(axis + 1) % 3] * factors[(axis + 2) % 3];
      }
    }
  }
  return { point: local.map((value, k) => value + origin[k]), jacobian };
}
function physicalBasis(domain, indices, active) {
  const u = indices.map((value, axis) => (value + 0.5) / domain.dimensions[axis]);
  const { jacobian } = pointAt(domain, u);
  const basis = [], scales = [];
  for (const axis of active) {
    let vector = [...jacobian[axis]];
    for (const previous of basis) {
      const projection = dot(vector, previous);
      vector = vector.map((value, k) => value - projection * previous[k]);
    }
    const length = Math.hypot(...vector);
    const fullLength = Math.hypot(...jacobian[axis]);
    if (!Number.isFinite(length) || !(length > fullLength * 1e-10)) return null;
    basis.push(vector.map(value => value / length));
    scales.push(length / domain.dimensions[axis]);
  }
  return { basis, scales };
}
function coordinates(point, center, basis, scales) {
  const delta = subtract(point, center);
  return basis.map((axis, k) => dot(delta, axis) / scales[k]);
}
function polynomialBasis(x, degree) {
  const values = [1, ...x];
  if (degree === 2) {
    for (let i = 0; i < x.length; i++) for (let j = i; j < x.length; j++) values.push(x[i] * x[j]);
  }
  return values;
}

// Column-pivoted, twice-orthogonalized QR. Normal equations would square the
// condition number of stretched or nearly degenerate physical stencils.
function weightedQR(rows, rightSides, columnCount) {
  if (rows.length < columnCount) return null;
  const columns = Array.from({ length: columnCount }, (_, column) => Float64Array.from(rows, row => row[column]));
  const order = Array.from({ length: columnCount }, (_, k) => k);
  const upper = Array.from({ length: columnCount }, () => new Float64Array(columnCount));
  const projected = Array.from({ length: columnCount }, () => [0, 0, 0]);
  let largest = 0;
  for (let k = 0; k < columnCount; k++) {
    let pivot = k, best = -1;
    for (let j = k; j < columnCount; j++) {
      const length = dot(columns[j], columns[j]);
      if (length > best) { best = length; pivot = j; }
    }
    if (pivot !== k) {
      [columns[k], columns[pivot]] = [columns[pivot], columns[k]];
      [order[k], order[pivot]] = [order[pivot], order[k]];
      for (let i = 0; i < k; i++) [upper[i][k], upper[i][pivot]] = [upper[i][pivot], upper[i][k]];
    }
    const length = Math.sqrt(best);
    largest = Math.max(largest, length);
    if (!Number.isFinite(length) || !(length > largest * 1e-10)) return null;
    upper[k][k] = length;
    const q = columns[k].map(value => value / length);
    for (let row = 0; row < q.length; row++) for (let component = 0; component < 3; component++) {
      projected[k][component] += q[row] * rightSides[row][component];
    }
    for (let j = k + 1; j < columnCount; j++) {
      let projection = dot(q, columns[j]);
      for (let row = 0; row < q.length; row++) columns[j][row] -= projection * q[row];
      const correction = dot(q, columns[j]);
      for (let row = 0; row < q.length; row++) columns[j][row] -= correction * q[row];
      upper[k][j] = projection + correction;
    }
  }
  const solution = Array.from({ length: columnCount }, () => [0, 0, 0]);
  for (let i = columnCount - 1; i >= 0; i--) for (let component = 0; component < 3; component++) {
    let value = projected[i][component];
    for (let j = i + 1; j < columnCount; j++) value -= upper[i][j] * solution[j][component];
    solution[i][component] = value / upper[i][i];
    if (!Number.isFinite(solution[i][component])) return null;
  }
  const coefficients = Array.from({ length: columnCount }, () => [0, 0, 0]);
  for (let k = 0; k < columnCount; k++) coefficients[order[k]] = solution[k];
  return coefficients;
}

function localFit(domain, indices, active) {
  const cache = cacheFor(domain), key = indexOf(domain.dimensions, indices);
  if (cache.fits.has(key)) {
    const found = cache.fits.get(key);
    cache.fits.delete(key); cache.fits.set(key, found);
    return found;
  }
  const center = Array.from(domain.positions.subarray(key * 3, key * 3 + 3));
  const geometry = physicalBasis(domain, indices, active);
  let fit = null;
  if (geometry) {
    const ranges = domain.dimensions.map((size, axis) => {
      if (size === 1) return [0];
      const count = Math.min(size, 5), start = clamp(indices[axis] - 2, 0, size - count);
      return Array.from({ length: count }, (_, k) => start + k);
    });
    const coordinatesList = [], rightSides = [], weights = [];
    for (const i of ranges[0]) for (const j of ranges[1]) for (const k of ranges[2]) {
      const neighbour = [i, j, k], index = indexOf(domain.dimensions, neighbour);
      const point = Array.from(domain.positions.subarray(index * 3, index * 3 + 3));
      const x = coordinates(point, center, geometry.basis, geometry.scales);
      const radius = active.reduce((sum, axis) => sum + (neighbour[axis] - indices[axis]) ** 2, 0);
      // A fixed positive fit weight is harmless: each fitted polynomial belongs
      // to its centre. The separate blending kernel makes the final field C2.
      const weight = 1 / (1 + radius);
      coordinatesList.push(x); weights.push(Math.sqrt(weight));
      rightSides.push(Array.from(domain.vectors.subarray(index * 3, index * 3 + 3), value => value * Math.sqrt(weight)));
    }
    for (const degree of active.length ? [2, 1] : [0]) {
      const rows = coordinatesList.map((x, row) => polynomialBasis(degree ? x : [], degree).map(value => value * weights[row]));
      const coefficients = weightedQR(rows, rightSides, rows[0].length);
      if (coefficients) { fit = { center, ...geometry, degree, coefficients }; break; }
    }
  }
  cache.fits.set(key, fit);
  if (cache.fits.size > FIT_CACHE_LIMIT) cache.fits.delete(cache.fits.keys().next().value);
  return fit;
}
function compactWeight(distance, radius = BLEND_RADIUS) {
  const r = Math.abs(distance) / radius;
  return r < 1 ? (1 - r * r) ** 3 : 0;
}
function sampleQuadratic(domain, u, point) {
  const active = domain.dimensions.flatMap((size, axis) => size > 1 ? [axis] : []);
  const effective = u.map((value, axis) => domain.dimensions[axis] === 1 ? 0.5 : value);
  const query = active.length === 3 ? point : pointAt(domain, effective).point;
  const q = effective.map((value, axis) => value * domain.dimensions[axis] - 0.5);
  const ranges = domain.dimensions.map((size, axis) => {
    const first = Math.max(0, Math.ceil(q[axis] - BLEND_RADIUS));
    const last = Math.min(size - 1, Math.floor(q[axis] + BLEND_RADIUS));
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => first + k);
  });
  const vector = [0, 0, 0];
  let total = 0, fallback;
  for (const i of ranges[0]) for (const j of ranges[1]) for (const k of ranges[2]) {
    const indices = [i, j, k];
    const weight = indices.reduce((value, index, axis) => value * compactWeight(index - q[axis]), 1);
    if (!(weight > 0)) continue;
    const fit = localFit(domain, indices, active);
    if (!fit) return { vector: null, fallback: rankNotice };
    if (fit.degree === 1) fallback = linearNotice;
    const x = coordinates(query, fit.center, fit.basis, fit.scales);
    const values = polynomialBasis(fit.degree ? x : [], fit.degree);
    for (let term = 0; term < values.length; term++) for (let component = 0; component < 3; component++) {
      vector[component] += weight * values[term] * fit.coefficients[term][component];
    }
    total += weight;
  }
  if (!(total > 0)) return { vector: null, fallback: rankNotice };
  const result = vector.map(value => value / total);
  return finiteVector(result) ? { vector: result, ...(fallback ? { fallback } : {}) } : { vector: null, fallback: rankNotice };
}

function derivativePattern(length, shift) {
  // Derivative of the Lagrange basis at zero, in centre-index units.
  const nodes = Array.from({ length }, (_, k) => shift + k);
  return nodes.map((node, j) => {
    let value = 0;
    for (let m = 0; m < length; m++) if (m !== j) {
      let product = 1 / (node - nodes[m]);
      for (let l = 0; l < length; l++) if (l !== j && l !== m) product *= -nodes[l] / (node - nodes[l]);
      value += product;
    }
    return value;
  });
}
function differentiate(domain, values, axis, patterns) {
  const dims = domain.dimensions, result = new Float64Array(values.length), size = dims[axis];
  if (size === 1) return result;
  const stencil = Math.min(size, 5);
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) for (let k = 0; k < dims[2]; k++) {
    const indices = [i, j, k], at = indices[axis];
    const start = clamp(at - Math.floor(stencil / 2), 0, size - stencil), shift = start - at;
    if (!patterns.has(shift)) patterns.set(shift, derivativePattern(stencil, shift));
    const weights = patterns.get(shift), target = indexOf(dims, indices) * 3;
    for (let n = 0; n < stencil; n++) {
      indices[axis] = start + n;
      const source = indexOf(dims, indices) * 3;
      for (let component = 0; component < 3; component++) result[target + component] += weights[n] * values[source + component];
    }
  }
  return result;
}
function prepareCubic(domain) {
  const cache = cacheFor(domain);
  if (cache.cubic) return cache.cubic;
  const arrays = [domain.vectors], patterns = Array.from({ length: 3 }, () => new Map());
  for (let mask = 1; mask < 8; mask++) {
    const axis = [0, 1, 2].find(k => mask & (1 << k));
    arrays[mask] = differentiate(domain, arrays[mask ^ (1 << axis)], axis, patterns[axis]);
  }
  cache.cubic = { arrays, fallback: domain.dimensions.some(size => size > 1 && size < 4) ? cubicNotice : undefined };
  return cache.cubic;
}
function hermite(t) {
  return {
    values: [2 * t ** 3 - 3 * t ** 2 + 1, -2 * t ** 3 + 3 * t ** 2],
    derivatives: [t ** 3 - 2 * t ** 2 + t, t ** 3 - t ** 2],
  };
}
function sampleCubic(domain, u) {
  const data = prepareCubic(domain), lower = [], upper = [], basis = [];
  for (let axis = 0; axis < 3; axis++) {
    const size = domain.dimensions[axis];
    if (size === 1) { lower.push(0); upper.push(0); basis.push({ values: [1, 0], derivatives: [0, 0] }); }
    else {
      const q = u[axis] * size - 0.5, first = clamp(Math.floor(q), 0, size - 2);
      lower.push(first); upper.push(first + 1); basis.push(hermite(q - first));
    }
  }
  const vector = [0, 0, 0];
  for (let vertex = 0; vertex < 8; vertex++) {
    const indices = [0, 1, 2].map(axis => (vertex >> axis) & 1 ? upper[axis] : lower[axis]);
    const index = indexOf(domain.dimensions, indices) * 3;
    for (let mask = 0; mask < 8; mask++) {
      let weight = 1;
      for (let axis = 0; axis < 3; axis++) {
        const factors = mask & (1 << axis) ? basis[axis].derivatives : basis[axis].values;
        weight *= factors[(vertex >> axis) & 1];
      }
      if (weight === 0) continue;
      for (let component = 0; component < 3; component++) vector[component] += weight * data.arrays[mask][index + component];
    }
  }
  return finiteVector(vector) ? { vector, ...(data.fallback ? { fallback: data.fallback } : {}) }
    : { vector: null, fallback: "Трикубическая реконструкция: нечисловые производные" };
}

/** Call once per prepared, immutable saved domain; coefficients are lazy. */
export function prepareStreamlineReconstruction(domain, method) {
  if (!["quadratic", "tricubic"].includes(method)) throw new Error("Неизвестный метод реконструкции поля");
  const dims = domain.dimensions, count = dims?.reduce((product, value) => product * value, 1);
  if (!dims || dims.length !== 3 || !dims.every(size => Number.isSafeInteger(size) && size > 0)
    || !Number.isSafeInteger(count) || domain.positions?.length !== count * 3 || domain.vectors?.length !== count * 3
    || !domain.positions.every(Number.isFinite) || !domain.vectors.every(Number.isFinite)) {
    throw new Error("Некорректные данные реконструкции поля");
  }
  if (method === "tricubic") {
    const data = prepareCubic(domain);
    return { method, ...(data.fallback ? { fallback: data.fallback } : {}) };
  }
  const cache = cacheFor(domain);
  cache.quadratic ??= { method };
  return cache.quadratic;
}

/** u stays within the physical hexahedron. The outer half-cell uses the
 * edge polynomial; integration stages outside the domain must be handled
 * explicitly by the caller. Components remain in physical Cartesian axes. */
export function sampleReconstructedVector(domain, u, point, method) {
  if (!["quadratic", "tricubic"].includes(method)) throw new Error("Неизвестный метод реконструкции поля");
  if (!u || u.length !== 3 || !u.every(Number.isFinite) || u.some(value => value < -1e-10 || value > 1 + 1e-10)
    || !point || !finiteVector(point)) return { vector: null, fallback: "Реконструкция: точка вне доступной области" };
  const bounded = u.map(value => clamp(value, 0, 1));
  return method === "quadratic" ? sampleQuadratic(domain, bounded, point) : sampleCubic(domain, bounded);
}
