// Source geometry follows solver 15784ff6607ecd22628f479d7c8a90f42301a855:
// task/03_nodes.jl::qcvNodesRecall, vsolver/04_mhj.jl::mhjRecall!, and
// vsolver/03_clmatrv.jl::MatrV (final AS rotation and mirror parity).
// Each BaseModel MHJ row is independent; dependent images reuse that row.
// geometryTimeModel supplies the current local frame through elements;
// amplitudeFactors supplies its time-dependent source multipliers.
import { mhjRowCount, mhjRows } from "../solver/mhjLayout.js";
import {
    applyMatrix4ToPoint,
    eulerRotationMatrix4,
    multiplyMatrix4,
    rotationXMatrix4,
} from "../solver/rotation3d.js";
import { trilinearElementPoint } from "./geometryDiscretization.js";
import { instanceVisible, primitiveVisible } from "./geometryRenderFilters.js";

export const SOURCE_VECTOR_LIMIT = 100_000;

function warning(code, message) {
    return { level: "warning", schemaId: "mhj", code, message };
}

function vector3(value) {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const result = value.map(item => Array.isArray(item) ? item[0] : item);
    return result.every(Number.isFinite) ? result : null;
}

function instanceKey(ls, as, ps) {
    return `${ls}:${as}:${ps}`;
}

function elementContext(primitive, record, filters) {
    if (!primitive?.discretization || !record) return null;
    if (!primitiveVisible(primitive, filters?.objectModes, filters?.selections)) {
        return null;
    }
    const vi = vector3(record.symVi);
    if (!vi) return null;

    const instances = new Map();
    for (const instance of primitive.instances) {
        if (!instanceVisible(instance, filters?.symmetry)) continue;
        // Geometric AS/PS have their own table rows. Physical images share
        // the zero-index independent row; mirrors always share its value.
        const key = instanceKey(
            instance.ls,
            (record.symKya ?? 0) === 0 ? instance.as : 0,
            (record.symKyp ?? 0) === 0 ? instance.ps : 0,
        );
        if (!instances.has(key)) instances.set(key, []);
        instances.get(key).push(instance);
    }

    return {
        primitive,
        record,
        instances,
        rotation: eulerRotationMatrix4(...vi),
        directionMatrices: new Map(),
        axialRotations: new Map(),
        cellKey: null,
        cell: null,
    };
}

function sourceCell(context, row) {
    const key = `${row.d12}:${row.d13}:${row.d15}`;
    if (context.cellKey === key) return context.cell;

    const counts = context.primitive.discretization.counts;
    const parameters = [row.d12, row.d13, row.d15].map(
        (index, axis) => (index - 0.5) / counts[axis],
    );
    const point = (...position) => trilinearElementPoint(
        context.primitive.vertices,
        ...position,
    );
    const origin = point(...parameters);
    const edgeLengths = parameters.map((value, axis) => {
        const lower = [...parameters];
        const upper = [...parameters];
        lower[axis] = value - 0.5 / counts[axis];
        upper[axis] = value + 0.5 / counts[axis];
        const a = point(...lower);
        const b = point(...upper);
        return a && b ? Math.hypot(...a.map((coordinate, i) => b[i] - coordinate)) : 0;
    });

    context.cellKey = key;
    context.cell = { origin, characteristicSize: Math.hypot(...edgeLengths) };
    return context.cell;
}

function sourceDirection(context, localVector, ls) {
    let matrix = context.directionMatrices.get(ls);
    if (!matrix) {
        // mhjRecall! stores VI and, when auto, LS in the base components.
        // MatrV applies the final AS rotation to their world-space image.
        // Both matrices have zero translation, so this application adds none.
        matrix = context.record.auto === true
            ? multiplyMatrix4(
                context.rotation,
                rotationXMatrix4(ls * context.record.symYl),
            )
            : context.rotation;
        context.directionMatrices.set(ls, matrix);
    }
    return applyMatrix4ToPoint(matrix, localVector);
}

function imageDirection(context, baseVector, instance, kind, general, amplitude) {
    let rotation = context.axialRotations.get(instance.as);
    if (!rotation) {
        rotation = rotationXMatrix4(instance.as * context.record.symYa);
        context.axialRotations.set(instance.as, rotation);
    }
    const vector = applyMatrix4ToPoint(rotation, baseVector);
    let sign = amplitude * (instance.axialSign ?? 1) * (instance.periodicSign ?? 1);

    for (const [reflected, axis, type] of [
        [instance.mirrorX, 0, general?.mirrorSymmetryX],
        [instance.mirrorY, 1, general?.mirrorSymmetryY],
    ]) {
        if (!reflected) continue;
        if (type !== 0 && type !== 1) return null;
        vector[axis] = -vector[axis];
        // Mirror types describe H, hence M. J gets the opposite parity
        // for each single reflection; two reflections cancel that factor.
        if (type === 1) sign = -sign;
        if (kind === "current") sign = -sign;
    }
    return vector.map(value => value * sign);
}

function sceneDiagonal(scene) {
    const bounds = scene?.bounds;
    if (!bounds?.min || !bounds?.max) return 0;
    const diagonal = Math.hypot(...[0, 1, 2].map(
        axis => bounds.max[axis] - bounds.min[axis],
    ));
    return Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 0;
}

/** Detached, world-space arrow data; no Three.js objects or BaseModel writes. */
export function buildSourceVectorScene(scene, elements, mhj, options = {}) {
    const vectors = [];
    const diagnostics = [];
    const result = {
        vectors,
        diagnostics,
        maximumMagnitude: { current: 0, magnetization: 0 },
        sceneDiagonal: sceneDiagonal(options.referenceScene ?? scene),
        rowsTruncated: false,
        imagesTruncated: false,
        truncated: false,
    };
    const expectedRows = mhjRowCount(elements);
    const sourceRecords = Array.isArray(mhj) ? mhj : [];
    if (sourceRecords.length > 1) {
        diagnostics.push(warning(
            "invalid-source-records",
            "Заданные источники: ожидается одна запись с таблицей векторов.",
        ));
        return result;
    }

    const values = sourceRecords[0]?.v ?? [];
    if (!Array.isArray(values)) {
        diagnostics.push(warning(
            "invalid-source-table",
            "Заданные источники: значение v не является таблицей векторов.",
        ));
        return result;
    }
    if (values.length !== expectedRows) {
        diagnostics.push(warning(
            "source-row-count",
            `Заданные источники: строк в таблице — ${values.length}, `
                + `независимых объёмов — ${expectedRows}. `
                + "Показываются только строки с соответствующим объёмом.",
        ));
    }

    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0
        ? Math.min(options.limit, SOURCE_VECTOR_LIMIT)
        : SOURCE_VECTOR_LIMIT;
    const matchedCount = Math.min(values.length, expectedRows);
    result.rowsTruncated = matchedCount > limit;
    // Index rows before visibility filters or skipping unusable geometry.
    // Those operations must never shift values to a subsequent volume.
    const rows = mhjRows(elements, { limit: Math.min(values.length, limit) });
    const primitives = new Map(
        (scene?.primitives ?? [])
            .filter(primitive => primitive.kind === "element-volume")
            .map(primitive => [primitive.source.recordIndex, primitive]),
    );
    const contexts = new Map();
    const magnitudes = new Float64Array(rows.length);
    let invalidValues = 0;
    let invalidGeometry = 0;
    let invalidAmplitudes = 0;

    // Complete this pass before amplitudes, visibility or the output limit.
    // Keep a fixed reference scale so a common A(t) remains visible in length.
    rows.forEach((row, sourceRowIndex) => {
        const localVector = values[sourceRowIndex];
        if (!Array.isArray(localVector) || localVector.length !== 3
            || !localVector.every(Number.isFinite)) {
            invalidValues++;
            return;
        }
        const magnitude = Math.hypot(...localVector);
        if (!Number.isFinite(magnitude)) {
            invalidValues++;
            return;
        }
        magnitudes[sourceRowIndex] = magnitude;
        if (!primitives.get(row.kv - 1)?.discretization) return;
        const kind = row.targ === 1 ? "magnetization" : "current";
        result.maximumMagnitude[kind] = Math.max(
            result.maximumMagnitude[kind], magnitude,
        );
    });

    sourceRows: for (let sourceRowIndex = 0; sourceRowIndex < rows.length; sourceRowIndex++) {
        const row = rows[sourceRowIndex];
        const baseMagnitude = magnitudes[sourceRowIndex];
        if (baseMagnitude === 0) continue;

        const recordIndex = row.kv - 1;
        const factor = options.amplitudeFactors?.[recordIndex];
        // null marks an invalid time dependence, diagnosed by its sampler.
        if (factor === null) continue;
        const amplitude = factor === undefined ? 1 : factor;
        const magnitude = baseMagnitude * Math.abs(amplitude);
        if (!Number.isFinite(amplitude) || !Number.isFinite(magnitude)) {
            invalidAmplitudes++;
            continue;
        }
        if (magnitude === 0) continue;
        if (!contexts.has(recordIndex)) {
            contexts.set(recordIndex, elementContext(
                primitives.get(recordIndex),
                elements?.[recordIndex],
                options.filters,
            ));
        }
        const context = contexts.get(recordIndex);
        const instances = context?.instances.get(instanceKey(
            row.ls - 1, row.as - 1, row.ps - 1,
        ));
        if (!instances?.length) continue;

        const cell = sourceCell(context, row);
        const baseVector = sourceDirection(context, values[sourceRowIndex], row.ls - 1);
        if (!cell.origin?.every(Number.isFinite) || !baseVector.every(Number.isFinite)
            || !Number.isFinite(cell.characteristicSize) || cell.characteristicSize <= 0) {
            invalidGeometry++;
            continue;
        }

        const kind = row.targ === 1 ? "magnetization" : "current";
        for (const instance of instances) {
            const origin = applyMatrix4ToPoint(instance.matrix, cell.origin);
            const vector = imageDirection(
                context, baseVector, instance, kind, options.general, amplitude,
            );
            if (!origin.every(Number.isFinite) || !vector?.every(Number.isFinite)) {
                invalidGeometry++;
                continue;
            }
            if (vectors.length >= limit) {
                result.imagesTruncated = true;
                break sourceRows;
            }
            vectors.push({
                source: { ...context.primitive.source },
                sourceRowIndex,
                volumeIndex: row.eoLocal,
                kind,
                origin,
                vector,
                magnitude,
                characteristicSize: cell.characteristicSize,
                instance: {
                    ls: instance.ls,
                    as: instance.as,
                    ps: instance.ps,
                    mirrorX: instance.mirrorX,
                    mirrorY: instance.mirrorY,
                },
            });
        }
    }

    if (invalidValues) {
        diagnostics.push(warning(
            "invalid-source-values",
            `Заданные источники: пропущено строк с некорректными компонентами — ${invalidValues}.`,
        ));
    }
    if (invalidAmplitudes) {
        diagnostics.push(warning(
            "invalid-source-amplitude",
            "Заданные источники: пропущено строк с нечисловой амплитудой "
                + `или переполнением модуля — ${invalidAmplitudes}.`,
        ));
    }
    if (invalidGeometry) {
        diagnostics.push(warning(
            "invalid-source-geometry",
            `Заданные источники: невозможно построить стрелку для ${invalidGeometry} объёмов.`,
        ));
    }
    result.truncated = result.rowsTruncated || result.imagesTruncated;
    return result;
}
