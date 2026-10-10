import test from "node:test";
import assert from "node:assert/strict";
import { prepareStreamlineReconstruction, sampleReconstructedVector } from "../src/services/visualization/resultStreamlineReconstruction.js";

function grid({ dims = [5, 5, 5], lo = [-2, -2, -2], hi = [2, 2, 2], vertices, field = () => [1, 2, 3] } = {}) {
  const corners = vertices ?? Array.from({ length: 8 }, (_, n) => [0, 1, 2].map(axis => (n >> axis) & 1 ? hi[axis] : lo[axis]));
  const origin = corners[0], localVertices = corners.map(point => point.map((value, axis) => value - origin[axis]));
  const pointAt = u => origin.map((value, component) => value + localVertices.reduce((sum, point, n) =>
    sum + point[component] * u.reduce((weight, position, axis) => weight * ((n >> axis) & 1 ? position : 1 - position), 1), 0));
  const positions = [], vectors = [];
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) for (let k = 0; k < dims[2]; k++) {
    const point = pointAt([i, j, k].map((value, axis) => (value + 0.5) / dims[axis]));
    positions.push(...point); vectors.push(...field(...point));
  }
  return { domain: { dimensions: dims, vertices: corners, origin, localVertices,
    positions: Float64Array.from(positions), vectors: Float64Array.from(vectors) }, pointAt };
}
function evaluate(setup, method, u) {
  return sampleReconstructedVector(setup.domain, u, setup.pointAt(u), method);
}
function close(actual, expected, tolerance = 1e-10) {
  assert.ok(actual && actual.length === 3);
  actual.forEach((value, component) => {
    assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(value - expected[component]) <= tolerance * Math.max(1, Math.abs(expected[component])),
      "component " + component + ": " + value + " instead of " + expected[component]);
  });
}
const samples = [[0, 0, 0], [1, 1, 1], [0, 0.41, 1], [0.31, 0.73, 0.58], [0.99, 0.01, 0.37]];

test("quadratic physical reconstruction reproduces cross terms at centres, faces and corners of a warped hexahedron", () => {
  const vertices = Array.from({ length: 8 }, (_, n) => {
    const u = n & 1, v = (n >> 1) & 1, w = (n >> 2) & 1;
    return [2 * u + 0.4 * v + 0.1 * w + 0.2 * u * v, 3 * v + 0.2 * w + 0.1 * u * w, w + 0.1 * u * v];
  });
  const field = (x, y, z) => [1 + x * x + y * z, x * y + z * z, 3 - y * y + x * z];
  const setup = grid({ vertices, field });
  prepareStreamlineReconstruction(setup.domain, "quadratic");
  for (const u of [...samples, [0.1, 0.5, 0.9]]) {
    const result = evaluate(setup, "quadratic", u);
    assert.equal(result.fallback, undefined);
    close(result.vector, field(...setup.pointAt(u)));
  }
});

test("tricubic Hermite shares mixed derivatives and reproduces tensor cubics through the physical half cells", () => {
  const field = (x, y, z) => [x ** 3 + x * y * z + y * y, y ** 3 + x * x * z * z, x ** 3 * y ** 3 * z ** 3];
  for (const dims of [[4, 4, 4], [6, 5, 7]]) {
    const setup = grid({ dims, field });
    assert.equal(prepareStreamlineReconstruction(setup.domain, "tricubic").fallback, undefined);
    for (const u of samples) close(evaluate(setup, "tricubic", u).vector, field(...setup.pointAt(u)), 5e-10);
  }
});

test("both reconstructions preserve constant and affine physical vectors, including magnitude", () => {
  for (const field of [() => [2, -3, 4], (x, y, z) => [2 + x + y, 3 * y - z, z - x]]) {
    const setup = grid({ field });
    for (const method of ["quadratic", "tricubic"]) {
      prepareStreamlineReconstruction(setup.domain, method);
      for (const u of samples) close(evaluate(setup, method, u).vector, field(...setup.pointAt(u)));
    }
  }
});

test("moving across a compact blending support edge keeps the quadratic field and its first derivative continuous", () => {
  const setup = grid({ dims: [9, 5, 5], field: (x, y, z) => [Math.sin(2 * x) + y * z, Math.cos(x + y), Math.sin(z)] });
  const u0 = 4 / 9, delta = 1e-6;
  const values = [-2, -1, 0, 1, 2].map(step => evaluate(setup, "quadratic", [u0 + step * delta, 0.37, 0.61]).vector);
  for (let component = 0; component < 3; component++) {
    assert.ok(Math.abs(values[3][component] - values[1][component]) < 1e-4);
    const left = (values[2][component] - values[1][component]) / delta;
    const right = (values[3][component] - values[2][component]) / delta;
    assert.ok(Math.abs(left - right) < 1e-3);
  }
});

test("shared Hermite derivatives give matching first derivatives across a centre plane for nonpolynomial data", () => {
  const setup = grid({ dims: [7, 5, 5], field: (x, y, z) => [Math.sin(x + y), Math.cos(2 * x) + z, x * Math.sin(z)] });
  const u0 = 3.5 / 7, delta = 1e-6;
  const left = evaluate(setup, "tricubic", [u0 - delta, 0.43, 0.57]).vector;
  const center = evaluate(setup, "tricubic", [u0, 0.43, 0.57]).vector;
  const right = evaluate(setup, "tricubic", [u0 + delta, 0.43, 0.57]).vector;
  for (let component = 0; component < 3; component++) {
    assert.ok(Math.abs((center[component] - left[component]) / delta - (right[component] - center[component]) / delta) < 1e-3);
  }
});

test("one-centre axes stay constant without inventing a normal gradient", () => {
  const field = (x, y, z) => [7 + x + 2 * y * y, z * z - y, y * z];
  const setup = grid({ dims: [1, 5, 5], field });
  for (const method of ["quadratic", "tricubic"]) {
    assert.equal(prepareStreamlineReconstruction(setup.domain, method).fallback, undefined);
    for (const u of samples) {
      const effective = [0.5, u[1], u[2]];
      const result = evaluate(setup, method, u);
      assert.equal(result.fallback, undefined);
      close(result.vector, field(...setup.pointAt(effective)));
    }
  }
  const constant = grid({ dims: [1, 1, 1], field: () => [9, -2, 3] });
  for (const method of ["quadratic", "tricubic"]) for (const u of samples) close(evaluate(constant, method, u).vector, [9, -2, 3]);
});

test("sparse axes report their lower order and preserve the supported polynomial", () => {
  const affine = (x, y) => [1 + 2 * x + y, x - y, 3];
  const sparse = grid({ dims: [2, 5, 1], field: affine });
  for (const method of ["quadratic", "tricubic"]) for (const u of samples) {
    const result = evaluate(sparse, method, u);
    assert.ok(result.fallback);
    close(result.vector, affine(...sparse.pointAt(u)));
  }
  const field = (x, y, z) => [x * x + y * z, y * y + z * z, x * y];
  const quadratic = grid({ dims: [3, 3, 3], field });
  assert.ok(prepareStreamlineReconstruction(quadratic.domain, "tricubic").fallback);
  for (const u of samples) close(evaluate(quadratic, "tricubic", u).vector, field(...quadratic.pointAt(u)));
});

test("centred physical fitting remains accurate after a large translation", () => {
  const offset = [1e9 + 0.125, -2e9 - 0.375, 3e9 + 0.625];
  const field = (x, y, z) => {
    const a = x - offset[0], b = y - offset[1], c = z - offset[2];
    return [a * a + b * c, b * b - a * c, 2 + a + b + c];
  };
  const setup = grid({ lo: offset, hi: offset.map(value => value + 8), field });
  for (const method of ["quadratic", "tricubic"]) for (const u of samples) {
    close(evaluate(setup, method, u).vector, field(...setup.pointAt(u)), method === "quadratic" ? 1e-10 : 2e-5);
  }
});

test("rank deficient and invalid samples return an explicit fallback instead of an invented vector", () => {
  const setup = grid();
  const first = setup.domain.positions.slice(0, 3);
  for (let node = 0; node < setup.domain.positions.length / 3; node++) setup.domain.positions.set(first, node * 3);
  const result = evaluate(setup, "quadratic", [0.5, 0.5, 0.5]);
  assert.equal(result.vector, null); assert.ok(result.fallback);
  const good = grid();
  for (const method of ["quadratic", "tricubic"]) {
    assert.equal(sampleReconstructedVector(good.domain, [NaN, 0.5, 0.5], [0, 0, 0], method).vector, null);
    assert.equal(sampleReconstructedVector(good.domain, [1.1, 0.5, 0.5], [0, 0, 0], method).vector, null);
  }
  good.domain.vectors[0] = NaN;
  assert.throws(() => prepareStreamlineReconstruction(good.domain, "quadratic"), /Некорректные/);
  assert.throws(() => prepareStreamlineReconstruction(grid().domain, "other"), /Неизвестный/);
});

test("domain caches stay separate and reconstruction does not change saved positions or components", () => {
  const a = grid({ field: () => [2, 3, 4] }), b = grid({ field: () => [5, 6, 7] });
  const before = Array.from(a.domain.vectors), coordinates = Array.from(a.domain.positions);
  for (const method of ["quadratic", "tricubic"]) {
    close(evaluate(a, method, [0.43, 0.57, 0.61]).vector, [2, 3, 4]);
    close(evaluate(b, method, [0.43, 0.57, 0.61]).vector, [5, 6, 7]);
  }
  assert.deepEqual(Array.from(a.domain.vectors), before);
  assert.deepEqual(Array.from(a.domain.positions), coordinates);
});
