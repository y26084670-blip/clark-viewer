// Observation areas are two-dimensional saved grids. A surface uses exactly
// their nodes and local-image topology; it never adds a thickness or extends
// support to geometry inferred from another object.
export function isResultSurfaceDomain(domain) {
  const dims = domain?.dimensions;
  return domain?.source?.schemaId === "regions" && Array.isArray(dims) && dims.length === 3
    && Number.isSafeInteger(dims[0]) && dims[0] >= 2
    && Number.isSafeInteger(dims[1]) && dims[1] >= 2 && dims[2] === 1;
}

function triangulate(domain) {
  if (!isResultSurfaceDomain(domain)) return null;
  const [n1, n2] = domain.dimensions, count = n1 * n2;
  if (!Number.isSafeInteger(count) || domain.positions?.length !== count * 3 || domain.values?.length !== count) return null;
  const positions = domain.positions instanceof Float64Array ? domain.positions : Float64Array.from(domain.positions);
  const values = domain.values instanceof Float64Array ? domain.values : Float64Array.from(domain.values);
  if (!positions.every(Number.isFinite) || !values.every(Number.isFinite)) return null;
  const indices = new Uint32Array((n1 - 1) * (n2 - 1) * 6);
  let offset = 0;
  const vector = (from, to) => [0, 1, 2].map(axis => positions[to * 3 + axis] - positions[from * 3 + axis]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (let i = 0; i < n1 - 1; i++) for (let j = 0; j < n2 - 1; j++) {
    const a = i * n2 + j, b = (i + 1) * n2 + j, c = b + 1, d = a + 1;
    const ab = vector(a, b), ac = vector(a, c), ad = vector(a, d);
    const scale = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...ad));
    if (!Number.isFinite(scale) || scale <= 0) return null;
    // Dimensionless tests work for tiny/large coordinates without squaring a
    // world-space length. Both halves must agree in orientation: no bow-tie fill.
    const first = cross(ab.map(value => value / scale), ac.map(value => value / scale));
    const second = cross(ac.map(value => value / scale), ad.map(value => value / scale));
    const firstArea = Math.hypot(...first), secondArea = Math.hypot(...second);
    const alignment = first.reduce((sum, value, axis) => sum + value * second[axis], 0);
    if (firstArea <= 1e-12 || secondArea <= 1e-12 || alignment <= firstArea * secondArea * 1e-12) return null;
    indices.set([a, b, c, a, c, d], offset); offset += 6;
  }
  return { key: domain.key, source: domain.source, instance: domain.instance, points: domain.points ?? [],
    dimensions: [...domain.dimensions], positions, values, indices };
}

export function buildResultSurfaceField({ domains }) {
  const surfaces = [], fallbackPoints = [], fallbackDomainKeys = [];
  let minimum = Infinity, maximum = -Infinity;
  for (const domain of domains) {
    for (const value of domain.values ?? []) if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    const surface = triangulate(domain);
    if (surface) surfaces.push(surface);
    else {
      fallbackDomainKeys.push(domain.key);
      for (const point of domain.points ?? []) fallbackPoints.push(point);
    }
  }
  return { surfaces, fallbackPoints, fallbackDomainKeys,
    minimum: Number.isFinite(minimum) ? minimum : 0, maximum: Number.isFinite(maximum) ? maximum : 0,
    notice: fallbackDomainKeys.length ? `Цветные узлы вместо поверхности: ${fallbackDomainKeys.length} площадок. Неполные, нечисловые, вырожденные или сложенные сетки не задают корректную поверхность` : "" };
}
