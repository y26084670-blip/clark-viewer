// Pure geometry helpers for the optional discretization overlays. The
// parameter directions follow the solver convention: element D1/D2/D3 are
// edges 1-2/1-3/1-5; region D1/D2 are edges 1-2/1-4.

export const DEFAULT_DISCRETIZATION_LIMITS = Object.freeze({
    lineSegments: 250_000,
    points: 100_000,
});

export const REGION_SURFACE_SUBDIVISION_LIMIT = 4;

const EMPTY_FLOAT64 = () => new Float64Array(0);

function scalarValue(value) {
    let scalar = value;

    while (
        (Array.isArray(scalar) || ArrayBuffer.isView(scalar))
        && scalar.length === 1
    ) {
        scalar = scalar[0];
    }

    return scalar;
}

/**
 * Converts a BaseModel scalar (including a nested one-cell matrix) to a safe
 * positive integer. Invalid values are rejected instead of rounded.
 */
export function normalizeDiscretizationCount(value) {
    const scalar = scalarValue(value);

    return Number.isSafeInteger(scalar) && scalar > 0 ? scalar : null;
}

/**
 * Normalizes the fixed-size `dp` vector used by an element or a region.
 */
export function normalizeDiscretizationCounts(values, dimensions) {
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) return null;
    if (!Array.isArray(values) && !ArrayBuffer.isView(values)) return null;
    if (values.length < dimensions) return null;

    const counts = [];

    for (let index = 0; index < dimensions; index++) {
        const count = normalizeDiscretizationCount(values[index]);
        if (count === null) return null;
        counts.push(count);
    }

    return counts;
}

function safeProduct(values) {
    let result = 1;

    for (const value of values) {
        if (
            !Number.isSafeInteger(value)
            || value < 0
            || result > Number.MAX_SAFE_INTEGER / Math.max(value, 1)
        ) {
            return Number.POSITIVE_INFINITY;
        }
        result *= value;
    }

    return result;
}

function scaleMetrics(metrics, instanceCount) {
    const multiplier = normalizeDiscretizationCount(instanceCount);
    if (!metrics || multiplier === null) return null;

    return {
        lineSegments: safeProduct([metrics.lineSegments, multiplier]),
        points: safeProduct([metrics.points, multiplier]),
    };
}

/**
 * Counts the visible element overlay before any coordinate arrays are built.
 * `instanceCount` accounts for symmetry images.
 */
export function countElementDiscretization(counts, instanceCount = 1) {
    const normalized = normalizeDiscretizationCounts(counts, 3);
    if (!normalized) return null;

    const [d1, d2, d3] = normalized;
    const metrics = {
        // The overlay includes the 12 main edges. Each internal division
        // additionally reaches four of the six boundary faces.
        lineSegments: 12
            + 4 * ((d1 - 1) + (d2 - 1) + (d3 - 1)),
        points: safeProduct(normalized),
    };

    return scaleMetrics(metrics, instanceCount);
}

function interiorRegionLineCount(count) {
    if (count === 1) return 1;
    return Math.max(0, count - 2);
}

/**
 * Counts a surface-region overlay, or the unique D2 nodes for a region-line.
 */
export function countRegionDiscretization(
    counts,
    options = {},
) {
    const isLine = typeof options === "boolean"
        ? options
        : options?.isLine === true;
    const instanceCount = typeof options === "boolean"
        ? 1
        : options?.instanceCount ?? 1;
    const normalized = normalizeDiscretizationCounts(counts, 2);
    if (!normalized) return null;

    const [d1, d2] = normalized;
    const metrics = isLine
        ? { lineSegments: 0, points: d2 }
        : {
            // Four main boundaries share the discretization line layer.
            lineSegments: 4
                + interiorRegionLineCount(d1)
                + interiorRegionLineCount(d2),
            points: safeProduct(normalized),
        };

    return scaleMetrics(metrics, instanceCount);
}

function normalizedLimit(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Checks a count result against rendering budgets. This function is suitable
 * for both a single primitive and an accumulated scene total.
 */
export function preflightDiscretization(
    metrics,
    limits = DEFAULT_DISCRETIZATION_LIMITS,
) {
    const normalizedLimits = {
        lineSegments: normalizedLimit(
            limits?.lineSegments,
            DEFAULT_DISCRETIZATION_LIMITS.lineSegments,
        ),
        points: normalizedLimit(
            limits?.points,
            DEFAULT_DISCRETIZATION_LIMITS.points,
        ),
    };
    const validMetrics = metrics
        && Number.isSafeInteger(metrics.lineSegments)
        && metrics.lineSegments >= 0
        && Number.isSafeInteger(metrics.points)
        && metrics.points >= 0;

    if (!validMetrics) {
        return {
            ok: false,
            reason: "invalid-counts",
            metrics: null,
            limits: normalizedLimits,
            exceeded: [],
        };
    }

    const exceeded = [];
    if (metrics.lineSegments > normalizedLimits.lineSegments) {
        exceeded.push("lineSegments");
    }
    if (metrics.points > normalizedLimits.points) exceeded.push("points");

    return {
        ok: exceeded.length === 0,
        reason: exceeded.length === 0 ? null : "budget-exceeded",
        metrics: { ...metrics },
        limits: normalizedLimits,
        exceeded,
    };
}

function normalizedVertices(vertices, expectedCount) {
    if (!Array.isArray(vertices) && !ArrayBuffer.isView(vertices)) return null;

    let result;
    const first = vertices[0];
    if (Array.isArray(first) || ArrayBuffer.isView(first)) {
        if (vertices.length !== expectedCount) return null;
        result = Array.from(vertices, vertex => Array.from(vertex));
    } else {
        if (vertices.length !== expectedCount * 3) return null;
        result = Array.from({ length: expectedCount }, (_, index) => [
            vertices[index * 3],
            vertices[index * 3 + 1],
            vertices[index * 3 + 2],
        ]);
    }

    return result.every(vertex =>
        vertex.length === 3 && vertex.every(Number.isFinite)
    ) ? result : null;
}

function trilinearPoint(points, d1, d2, d3) {
    const weights = [
        (1 - d1) * (1 - d2) * (1 - d3),
        d1 * (1 - d2) * (1 - d3),
        (1 - d1) * d2 * (1 - d3),
        d1 * d2 * (1 - d3),
        (1 - d1) * (1 - d2) * d3,
        d1 * (1 - d2) * d3,
        (1 - d1) * d2 * d3,
        d1 * d2 * d3,
    ];

    return [0, 1, 2].map(axis =>
        points.reduce(
            (sum, point, index) => sum + point[axis] * weights[index],
            0,
        )
    );
}

/** Solver-compatible trilinear map for an eight-vertex element. */
export function trilinearElementPoint(vertices, d1, d2, d3) {
    const points = normalizedVertices(vertices, 8);
    if (
        !points
        || ![d1, d2, d3].every(value =>
            typeof value === "number" && Number.isFinite(value)
        )
    ) {
        return null;
    }

    return trilinearPoint(points, d1, d2, d3);
}

function bilinearPoint(points, d1, d2) {
    const weights = [
        (1 - d1) * (1 - d2),
        d1 * (1 - d2),
        d1 * d2,
        (1 - d1) * d2,
    ];

    return [0, 1, 2].map(axis =>
        points.reduce(
            (sum, point, index) => sum + point[axis] * weights[index],
            0,
        )
    );
}

/** Solver-compatible bilinear map for a four-vertex region. */
export function bilinearRegionPoint(vertices, d1, d2) {
    const points = normalizedVertices(vertices, 4);
    if (
        !points
        || ![d1, d2].every(value =>
            typeof value === "number" && Number.isFinite(value)
        )
    ) {
        return null;
    }

    return bilinearPoint(points, d1, d2);
}

function appendPoint(target, point) {
    target.push(point[0], point[1], point[2]);
}

function appendLine(target, start, end) {
    appendPoint(target, start);
    appendPoint(target, end);
}

function failedBuild(reason, counts = null, preflight = null) {
    return {
        ok: false,
        reason,
        lines: EMPTY_FLOAT64(),
        points: EMPTY_FLOAT64(),
        pointMetadata: [],
        counts,
        preflight,
    };
}

function internalElementParameters(count) {
    return Array.from(
        { length: Math.max(0, count - 1) },
        (_, index) => (index + 1) / count,
    );
}

/**
 * Builds local-space main edges and discretization lines on all six element
 * faces, plus elementary-volume centres. Every line is represented by two
 * consecutive XYZ vertices.
 */
export function buildElementDiscretization(
    vertices,
    counts,
    options = {},
) {
    const limits = options?.limits ?? DEFAULT_DISCRETIZATION_LIMITS;
    const includeLines = options?.includeLines !== false;
    const includePoints = options?.includePoints !== false;
    const normalized = normalizeDiscretizationCounts(counts, 3);
    const points = normalizedVertices(vertices, 8);
    if (!normalized) return failedBuild("invalid-counts");
    if (!points) return failedBuild("invalid-vertices");

    const availableMetrics = countElementDiscretization(normalized);
    const metrics = {
        lineSegments: includeLines ? availableMetrics.lineSegments : 0,
        points: includePoints ? availableMetrics.points : 0,
    };
    const preflight = preflightDiscretization(metrics, limits);
    if (!preflight.ok) {
        return failedBuild(preflight.reason, metrics, preflight);
    }

    const [d1, d2, d3] = normalized;
    const lines = [];
    const centres = [];
    const pointMetadata = [];
    const map = (u, v, w) => trilinearPoint(points, u, v, w);

    if (includeLines) {
        // Main edges use the same overlay geometry/material as internal lines.
        for (const v of [0, 1]) {
            for (const w of [0, 1]) {
                appendLine(lines, map(0, v, w), map(1, v, w));
            }
        }
        for (const u of [0, 1]) {
            for (const w of [0, 1]) {
                appendLine(lines, map(u, 0, w), map(u, 1, w));
            }
        }
        for (const u of [0, 1]) {
            for (const v of [0, 1]) {
                appendLine(lines, map(u, v, 0), map(u, v, 1));
            }
        }

        const p1 = internalElementParameters(d1);
        const p2 = internalElementParameters(d2);
        const p3 = internalElementParameters(d3);

        for (const w of [0, 1]) {
            for (const u of p1) {
                appendLine(lines, map(u, 0, w), map(u, 1, w));
            }
            for (const v of p2) {
                appendLine(lines, map(0, v, w), map(1, v, w));
            }
        }
        for (const v of [0, 1]) {
            for (const u of p1) {
                appendLine(lines, map(u, v, 0), map(u, v, 1));
            }
            for (const w of p3) {
                appendLine(lines, map(0, v, w), map(1, v, w));
            }
        }
        for (const u of [0, 1]) {
            for (const v of p2) {
                appendLine(lines, map(u, v, 0), map(u, v, 1));
            }
            for (const w of p3) {
                appendLine(lines, map(u, 0, w), map(u, 1, w));
            }
        }
    }

    // D3 is the innermost loop, matching the solver numbering order.
    if (includePoints) {
        for (let i1 = 0; i1 < d1; i1++) {
            for (let i2 = 0; i2 < d2; i2++) {
                for (let i3 = 0; i3 < d3; i3++) {
                    appendPoint(centres, map(
                        (i1 + 0.5) / d1,
                        (i2 + 0.5) / d2,
                        (i3 + 0.5) / d3,
                    ));
                    pointMetadata.push({
                        kind: "element-center",
                        d1: i1 + 1,
                        d2: i2 + 1,
                        d3: i3 + 1,
                    });
                }
            }
        }
    }

    return {
        ok: true,
        reason: null,
        lines: new Float64Array(lines),
        points: new Float64Array(centres),
        pointMetadata,
        counts: metrics,
        preflight,
    };
}

function regionParameters(count) {
    if (count === 1) return [0.5];
    return Array.from({ length: count }, (_, index) => index / (count - 1));
}

function internalRegionParameters(count) {
    return regionParameters(count).filter(value => value > 0 && value < 1);
}

/**
 * Builds a bilinear surface grid including its four main boundaries and its
 * solver nodes. For a degenerate region-line only the geometrically unique D2
 * nodes are returned.
 */
export function buildRegionDiscretization(
    vertices,
    counts,
    options = {},
) {
    const isLine = typeof options === "boolean"
        ? options
        : options?.isLine === true;
    const limits = typeof options === "boolean"
        ? DEFAULT_DISCRETIZATION_LIMITS
        : options?.limits ?? DEFAULT_DISCRETIZATION_LIMITS;
    const includeLines = typeof options === "boolean"
        ? true
        : options?.includeLines !== false;
    const includePoints = typeof options === "boolean"
        ? true
        : options?.includePoints !== false;
    const normalized = normalizeDiscretizationCounts(counts, 2);
    let points = normalizedVertices(vertices, 4);
    if (!points && isLine) {
        const endpoints = normalizedVertices(vertices, 2);
        if (endpoints) {
            points = [
                endpoints[0],
                endpoints[0],
                endpoints[1],
                endpoints[1],
            ];
        }
    }
    if (!normalized) return failedBuild("invalid-counts");
    if (!points) return failedBuild("invalid-vertices");

    const availableMetrics = countRegionDiscretization(normalized, { isLine });
    const metrics = {
        lineSegments: includeLines ? availableMetrics.lineSegments : 0,
        points: includePoints ? availableMetrics.points : 0,
    };
    const preflight = preflightDiscretization(metrics, limits);
    if (!preflight.ok) {
        return failedBuild(preflight.reason, metrics, preflight);
    }

    const [d1, d2] = normalized;
    const lines = [];
    const nodes = [];
    const pointMetadata = [];
    const map = (u, v) => bilinearPoint(points, u, v);

    if (isLine) {
        if (includePoints) {
            const parameters2 = regionParameters(d2);
            for (let i2 = 0; i2 < d2; i2++) {
                appendPoint(nodes, map(0.5, parameters2[i2]));
                pointMetadata.push({ kind: "region-node", d2: i2 + 1 });
            }
        }
    } else {
        if (includeLines) {
            appendLine(lines, map(0, 0), map(1, 0));
            appendLine(lines, map(0, 1), map(1, 1));
            appendLine(lines, map(0, 0), map(0, 1));
            appendLine(lines, map(1, 0), map(1, 1));

            for (const u of internalRegionParameters(d1)) {
                appendLine(lines, map(u, 0), map(u, 1));
            }
            for (const v of internalRegionParameters(d2)) {
                appendLine(lines, map(0, v), map(1, v));
            }
        }

        if (includePoints) {
            const parameters1 = regionParameters(d1);
            const parameters2 = regionParameters(d2);
            for (let i1 = 0; i1 < d1; i1++) {
                for (let i2 = 0; i2 < d2; i2++) {
                    appendPoint(nodes, map(
                        parameters1[i1],
                        parameters2[i2],
                    ));
                    pointMetadata.push({
                        kind: "region-node",
                        d1: i1 + 1,
                        d2: i2 + 1,
                    });
                }
            }
        }
    }

    return {
        ok: true,
        reason: null,
        lines: new Float64Array(lines),
        points: new Float64Array(nodes),
        pointMetadata,
        counts: metrics,
        preflight,
    };
}

function normalizedSubdivisions(value) {
    const normalized = normalizeDiscretizationCount(value);
    if (normalized === null) return REGION_SURFACE_SUBDIVISION_LIMIT;
    return Math.min(normalized, REGION_SURFACE_SUBDIVISION_LIMIT);
}

/**
 * Approximates the solver's bilinear region surface without coupling render
 * quality to `dp`. The per-axis subdivision count is capped at four.
 */
export function tessellateBilinearRegionSurface(vertices, subdivisions = 4) {
    const points = normalizedVertices(vertices, 4);
    if (!points) {
        return {
            vertices: EMPTY_FLOAT64(),
            indices: new Uint32Array(0),
        };
    }

    const requested = (
        Array.isArray(subdivisions) || ArrayBuffer.isView(subdivisions)
    ) ? subdivisions : [subdivisions, subdivisions];
    const d1 = normalizedSubdivisions(requested[0]);
    const d2 = normalizedSubdivisions(requested[1]);
    const surfaceVertices = [];
    const indices = [];

    for (let i1 = 0; i1 <= d1; i1++) {
        for (let i2 = 0; i2 <= d2; i2++) {
            appendPoint(
                surfaceVertices,
                bilinearPoint(points, i1 / d1, i2 / d2),
            );
        }
    }

    const rowLength = d2 + 1;
    for (let i1 = 0; i1 < d1; i1++) {
        for (let i2 = 0; i2 < d2; i2++) {
            const v1 = i1 * rowLength + i2;
            const v2 = (i1 + 1) * rowLength + i2;
            const v3 = v2 + 1;
            const v4 = v1 + 1;
            indices.push(v1, v2, v3, v1, v3, v4);
        }
    }

    return {
        vertices: new Float64Array(surfaceVertices),
        indices: new Uint32Array(indices),
    };
}
