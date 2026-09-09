import { toStorage } from "../model/arrayShape.js";
import { unpackKvVertices } from "../solver/geometryKv.js";
import { unpackTkVertices } from "../solver/geometryTk.js";
import {
    expandElementSymmetry,
    expandRegionSymmetry,
} from "../solver/symmetryExpansion.js";
import { tessellateBilinearRegionSurface }
    from "./geometryDiscretization.js";
import { classifyGeometryMaterial }
    from "./geometryMaterialStyle.js";

const ELEMENT_GEO_TYPES = new Set([0, 1, 2, 3, 4]);
const REGION_GEO_TYPES = new Set([0, 1, 2, 3]);
const ELEMENTS_SCHEMA_ID = "elements";
const REGIONS_SCHEMA_ID = "regions";

// Scene DTO is rebuilt synchronously on BaseModel changes. Keep both a
// per-record and a whole-scene guard before symmetry matrices are allocated.
export const GEOMETRY_RECORD_INSTANCE_LIMIT = 20_000;
export const GEOMETRY_SCENE_INSTANCE_LIMIT = 20_000;
const MAX_FLOAT32_COORDINATE = 3.402823466e38;
const MAX_UINT32 = 0xffff_ffff;

// BaseModel -> solver-buffer shapes. These descriptors repeat the ARRAY shape
// contract of elements/regions schemas without importing UI schema modules into
// this pure Node-testable adapter.
const SOLVER_ARRAY_SHAPES = Object.freeze({
    geo: Object.freeze({ nColumns: 3, order: "row" }),
    dr: Object.freeze({ nColumns: 1 }),
    dp: Object.freeze({ nColumns: 1 }),
    symVi: Object.freeze({ nColumns: 1 }),
    symR0: Object.freeze({ nColumns: 1 }),
});

// Six outward-facing quads in solver vertex order, split into triangles.
// Vertex numbers in the model are one-based; indices below are zero-based.
const ELEMENT_INDICES = new Uint16Array([
    0, 4, 6, 0, 6, 2, // 1-5-7-3
    1, 3, 7, 1, 7, 5, // 2-4-8-6
    0, 2, 3, 0, 3, 1, // 1-3-4-2
    4, 5, 7, 4, 7, 6, // 5-6-8-7
    0, 1, 5, 0, 5, 4, // 1-2-6-5
    2, 6, 7, 2, 7, 3, // 3-7-8-4
]);

// Explicit main-edge topology is retained in the Scene DTO. Besides avoiding
// the angle-based heuristics of Three.EdgesGeometry, it gives collapsed
// geometry a deterministic line fallback even when the regular edge overlay
// is disabled.
const ELEMENT_EDGE_INDICES = new Uint16Array([
    0, 1, 2, 3, 4, 5, 6, 7, // 1-2, 3-4, 5-6, 7-8
    0, 2, 1, 3, 4, 6, 5, 7, // 1-3, 2-4, 5-7, 6-8
    0, 4, 1, 5, 2, 6, 3, 7, // 1-5, 2-6, 3-7, 4-8
]);
const REGION_EDGE_INDICES = new Uint16Array([
    0, 1, 1, 2, 2, 3, 3, 0,
]);
const REGION_LINE_INDICES = new Uint16Array([0, 1]);

function diagnostic(schemaId, recordIndex, property, code, message) {
    return {
        level: "warning",
        schemaId,
        recordIndex,
        property,
        code,
        message,
    };
}

function flattenProperty(record, propertyName) {
    const value = record?.[propertyName];

    return Array.isArray(value)
        ? toStorage(value, SOLVER_ARRAY_SHAPES[propertyName])
        : value;
}

function normalizedRecord(record) {
    return {
        ...record,
        geo: flattenProperty(record, "geo"),
        dr: flattenProperty(record, "dr"),
        dp: flattenProperty(record, "dp"),
        symVi: flattenProperty(record, "symVi"),
        symR0: flattenProperty(record, "symR0"),
    };
}

function discretizationDescriptor(kind, value, count) {
    if (
        !Array.isArray(value)
        || value.length < count
        || !value.slice(0, count).every(item =>
            Number.isSafeInteger(item)
            && item >= 1
            && item <= MAX_UINT32
        )
    ) {
        return null;
    }

    return {
        kind,
        counts: Uint32Array.from(value.slice(0, count)),
    };
}

function invalidDiscretizationDiagnostic(schemaId, recordIndex) {
    return diagnostic(
        schemaId,
        recordIndex,
        "dp",
        "invalid-discretization",
        "Слой дискретизации недоступен: значения dp должны быть "
            + "положительными целыми числами Uint32",
    );
}

function isFiniteVector(value, length) {
    return Array.isArray(value)
        && value.length >= length
        && value.slice(0, length).every(Number.isFinite);
}

function hasFiniteVectorTransforms(record) {
    return isFiniteVector(record.dr, 3)
        && isFiniteVector(record.symVi, 3)
        && isFiniteVector(record.symR0, 3);
}

function hasFiniteElementTransforms(record) {
    return hasFiniteVectorTransforms(record)
        && Number.isFinite(record.symYl)
        && Number.isFinite(record.symYa)
        && Number.isFinite(record.symTx);
}

function hasFiniteRegionTransforms(record) {
    return hasFiniteVectorTransforms(record)
        && Number.isFinite(record.symYl);
}

function symmetryCount(factors) {
    let count = 1;

    for (const factor of factors) {
        if (!Number.isSafeInteger(factor) || factor <= 0) return 0;
        if (count > Number.MAX_SAFE_INTEGER / factor) {
            return Number.POSITIVE_INFINITY;
        }
        count *= factor;
    }

    return count;
}

function mirrorFactor(setting) {
    return setting === 0 || setting === 1 ? 2 : 1;
}

function elementInstanceCount(record, general) {
    return symmetryCount([
        record.symLs,
        record.symAs,
        record.symPs,
        mirrorFactor(general?.mirrorSymmetryY),
        mirrorFactor(general?.mirrorSymmetryX),
    ]);
}

function regionInstanceCount(record) {
    return symmetryCount([record.symLs]);
}

function instanceLimitDiagnostic(schemaId, recordIndex, count, limit) {
    const requested = Number.isFinite(count)
        ? String(count)
        : "слишком много";

    return diagnostic(
        schemaId,
        recordIndex,
        "symLs",
        "instance-budget-exceeded",
        `Запись требует ${requested} образов; предел для текущей сцены — ${limit}`,
    );
}

function flattenVertices(vertices) {
    return new Float64Array(vertices.flat());
}

function finiteVertices(vertices, expectedCount) {
    return Array.isArray(vertices)
        && vertices.length === expectedCount
        && vertices.every(vertex =>
            Array.isArray(vertex)
            && vertex.length === 3
            && vertex.every(Number.isFinite)
        );
}

function source(schemaId, recordIndex, record) {
    return {
        schemaId,
        recordIndex,
        name: typeof record?.name === "string" ? record.name : "",
    };
}

function normalizeInstances(instances) {
    if (!Array.isArray(instances)) return [];

    return instances.flatMap(instance => {
        const matrix = instance?.matrix;

        if (
            !matrix
            || matrix.length !== 16
            || !Array.from(matrix).every(Number.isFinite)
        ) {
            return [];
        }

        return [{
            matrix: matrix instanceof Float64Array
                ? matrix
                : new Float64Array(matrix),
            ls: instance.ls,
            as: instance.as,
            ps: instance.ps,
            mirrorX: instance.mirrorX,
            mirrorY: instance.mirrorY,
            axialSign: instance.axialSign,
            periodicSign: instance.periodicSign,
        }];
    });
}

function transformPoint(matrix, x, y, z) {
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
}

function hasRenderableCoordinates(primitive) {
    for (const instance of primitive.instances) {
        for (let offset = 0; offset < primitive.vertices.length; offset += 3) {
            const point = transformPoint(
                instance.matrix,
                primitive.vertices[offset],
                primitive.vertices[offset + 1],
                primitive.vertices[offset + 2],
            );

            if (point.some(coordinate =>
                !Number.isFinite(coordinate)
                || Math.abs(coordinate) > MAX_FLOAT32_COORDINATE
            )) {
                return false;
            }
        }
    }

    return true;
}

function includePrimitiveBounds(accumulator, primitive) {
    for (const instance of primitive.instances) {
        for (let offset = 0; offset < primitive.vertices.length; offset += 3) {
            const point = transformPoint(
                instance.matrix,
                primitive.vertices[offset],
                primitive.vertices[offset + 1],
                primitive.vertices[offset + 2],
            );

            for (let axis = 0; axis < 3; axis++) {
                accumulator.min[axis] = Math.min(
                    accumulator.min[axis],
                    point[axis],
                );
                accumulator.max[axis] = Math.max(
                    accumulator.max[axis],
                    point[axis],
                );
            }
        }
    }
}

function createBounds(primitives) {
    if (primitives.length === 0) return null;

    const accumulator = {
        min: new Float64Array([
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
        ]),
        max: new Float64Array([
            Number.NEGATIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ]),
    };

    primitives.forEach(primitive =>
        includePrimitiveBounds(accumulator, primitive)
    );

    return accumulator;
}

function createCounts(primitives, skipped) {
    const counts = {
        elements: 0,
        regions: 0,
        primitives: primitives.length,
        instances: 0,
        vertices: 0,
        triangles: 0,
        lines: 0,
        skipped,
    };

    for (const primitive of primitives) {
        const instanceCount = primitive.instances.length;
        const vertexCount = primitive.vertices.length / 3;

        counts.instances += instanceCount;
        counts.vertices += vertexCount * instanceCount;

        if (primitive.kind === "element-volume") {
            counts.elements++;
            counts.triangles += primitive.indices.length / 3
                * instanceCount;
        }
        else {
            counts.regions++;

            if (primitive.kind === "region-line") {
                counts.lines += primitive.indices.length / 2
                    * instanceCount;
            }
            else {
                counts.triangles += primitive.indices.length / 3
                    * instanceCount;
            }
        }
    }

    return counts;
}

function elementPrimitive(record, recordIndex, general, remainingInstances) {
    const normalized = normalizedRecord(record);

    if (!ELEMENT_GEO_TYPES.has(normalized.geoType)) {
        return {
            diagnostic: diagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                "geoType",
                "unsupported-geometry",
                `Неизвестный тип геометрии элемента: ${String(normalized.geoType)}`,
            ),
        };
    }

    if (!hasFiniteElementTransforms(normalized)) {
        return {
            diagnostic: diagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                "symVi",
                "invalid-transform",
                "Преобразование элемента содержит некорректные координаты",
            ),
        };
    }

    const discretization = discretizationDescriptor(
        "element-cells",
        normalized.dp,
        3,
    );

    const unpacked = unpackKvVertices(normalized.geo, normalized.geoType);

    if (!finiteVertices(unpacked.vertices, 8)) {
        return {
            diagnostic: diagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                "geo",
                "invalid-geometry",
                "Геометрия элемента не может быть показана",
            ),
        };
    }

    const requestedInstances = elementInstanceCount(normalized, general);

    if (requestedInstances === 0) {
        return {
            diagnostic: diagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                "symLs",
                "invalid-symmetry",
                "Число образов симметрии элемента некорректно",
            ),
        };
    }

    const allowedInstances = Math.min(
        GEOMETRY_RECORD_INSTANCE_LIMIT,
        remainingInstances,
    );

    if (requestedInstances > allowedInstances) {
        return {
            diagnostic: instanceLimitDiagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                requestedInstances,
                allowedInstances,
            ),
        };
    }

    const instances = normalizeInstances(
        expandElementSymmetry(normalized, general),
    );

    if (
        instances.length === 0
        || instances.length !== requestedInstances
    ) {
        return {
            diagnostic: diagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
                "symVi",
                "invalid-transform",
                "Преобразование одного или нескольких образов элемента некорректно",
            ),
        };
    }

    return {
        ...(!discretization && {
            diagnostic: invalidDiscretizationDiagnostic(
                ELEMENTS_SCHEMA_ID,
                recordIndex,
            ),
        }),
        primitive: {
            kind: "element-volume",
            materialKind: classifyGeometryMaterial(record, general),
            source: source(ELEMENTS_SCHEMA_ID, recordIndex, record),
            ...(discretization && { discretization }),
            vertices: flattenVertices(unpacked.vertices),
            indices: new Uint16Array(ELEMENT_INDICES),
            edgeIndices: new Uint16Array(ELEMENT_EDGE_INDICES),
            instances,
        },
    };
}

function regionPrimitive(record, recordIndex, remainingInstances) {
    const normalized = normalizedRecord(record);

    if (!REGION_GEO_TYPES.has(normalized.geoType)) {
        return {
            diagnostic: diagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                "geoType",
                "unsupported-geometry",
                `Неизвестный тип геометрии области: ${String(normalized.geoType)}`,
            ),
        };
    }

    if (!hasFiniteRegionTransforms(normalized)) {
        return {
            diagnostic: diagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                "symVi",
                "invalid-transform",
                "Преобразование области содержит некорректные координаты",
            ),
        };
    }

    const isLine = normalized.geoType === 2;
    const discretization = discretizationDescriptor(
        isLine ? "region-line" : "region-grid",
        normalized.dp,
        2,
    );

    const unpacked = unpackTkVertices(normalized.geo, normalized.geoType);

    if (!finiteVertices(unpacked.vertices, 4)) {
        return {
            diagnostic: diagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                "geo",
                "invalid-geometry",
                "Геометрия области не может быть показана",
            ),
        };
    }

    const requestedInstances = regionInstanceCount(normalized);

    if (requestedInstances === 0) {
        return {
            diagnostic: diagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                "symLs",
                "invalid-symmetry",
                "Число образов симметрии области некорректно",
            ),
        };
    }

    const allowedInstances = Math.min(
        GEOMETRY_RECORD_INSTANCE_LIMIT,
        remainingInstances,
    );

    if (requestedInstances > allowedInstances) {
        return {
            diagnostic: instanceLimitDiagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                requestedInstances,
                allowedInstances,
            ),
        };
    }

    const instances = normalizeInstances(
        expandRegionSymmetry(normalized),
    );

    if (
        instances.length === 0
        || instances.length !== requestedInstances
    ) {
        return {
            diagnostic: diagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
                "symVi",
                "invalid-transform",
                "Преобразование одного или нескольких образов области некорректно",
            ),
        };
    }

    const surface = isLine
        ? null
        : tessellateBilinearRegionSurface(unpacked.vertices);
    const vertices = isLine
        ? flattenVertices([unpacked.vertices[0], unpacked.vertices[2]])
        : surface.vertices;

    return {
        ...(!discretization && {
            diagnostic: invalidDiscretizationDiagnostic(
                REGIONS_SCHEMA_ID,
                recordIndex,
            ),
        }),
        primitive: {
            kind: isLine ? "region-line" : "region-surface",
            source: source(REGIONS_SCHEMA_ID, recordIndex, record),
            ...(discretization && { discretization }),
            ...(!isLine && {
                controlVertices: flattenVertices(unpacked.vertices),
            }),
            vertices,
            indices: isLine
                ? new Uint16Array(REGION_LINE_INDICES)
                : surface.indices,
            edgeIndices: isLine
                ? new Uint16Array(REGION_LINE_INDICES)
                : new Uint16Array(REGION_EDGE_INDICES),
            instances,
        },
    };
}

function appendRecords({
    records,
    createPrimitive,
    primitives,
    diagnostics,
    onPrimitive,
}) {
    if (!Array.isArray(records)) return 0;

    let skipped = 0;

    records.forEach((record, recordIndex) => {
        try {
            const result = createPrimitive(record, recordIndex);

            if (
                result.primitive
                && hasRenderableCoordinates(result.primitive)
            ) {
                primitives.push(result.primitive);
                onPrimitive?.(result.primitive);
                if (result.diagnostic) {
                    diagnostics.push(result.diagnostic);
                }
            }
            else if (result.primitive) {
                skipped++;
                diagnostics.push(diagnostic(
                    result.primitive.source.schemaId,
                    recordIndex,
                    "symVi",
                    "invalid-transform",
                    "Преобразованные координаты выходят за пределы 3D-представления",
                ));
            }
            else {
                skipped++;
                diagnostics.push(result.diagnostic);
            }
        }
        catch (error) {
            skipped++;
            diagnostics.push(diagnostic(
                createPrimitive.schemaId,
                recordIndex,
                "geo",
                "scene-conversion-failed",
                error instanceof Error
                    ? error.message
                    : "Не удалось преобразовать геометрию",
            ));
        }
    });

    return skipped;
}

// BaseModel -> detached render-oriented DTO. The original model is not changed.
export function buildGeometryScene(model = {}) {
    const primitives = [];
    const diagnostics = [];
    const general = model?.general ?? {};
    let remainingInstances = GEOMETRY_SCENE_INSTANCE_LIMIT;
    const createElement = (record, recordIndex) => elementPrimitive(
        record,
        recordIndex,
        general,
        remainingInstances,
    );
    const createRegion = (record, recordIndex) => regionPrimitive(
        record,
        recordIndex,
        remainingInstances,
    );
    const reservePrimitive = (primitive) => {
        remainingInstances -= primitive.instances.length;
    };

    createElement.schemaId = ELEMENTS_SCHEMA_ID;
    createRegion.schemaId = REGIONS_SCHEMA_ID;

    const skipped = appendRecords({
        records: model?.elements,
        createPrimitive: createElement,
        primitives,
        diagnostics,
        onPrimitive: reservePrimitive,
    }) + appendRecords({
        records: model?.regions,
        createPrimitive: createRegion,
        primitives,
        diagnostics,
        onPrimitive: reservePrimitive,
    });

    return {
        primitives,
        diagnostics,
        bounds: createBounds(primitives),
        counts: createCounts(primitives, skipped),
    };
}
