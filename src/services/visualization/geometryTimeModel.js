// Time projection follows solver 4d648564c10afe871910079d036e6b0bbc636cbf:
// task/02_moves.jl::moveRecall, task/02_amplitudes.jl::ampRecall,
// base/04_symmetry.jl::update_sym, and base/04_approx.jl::calc.
// All values remain detached from BaseModel and its editing history.

function warning(schemaId, property, code, message, recordIndex) {
    return {
        level: "warning",
        schemaId,
        ...(recordIndex === undefined ? {} : { recordIndex }),
        property,
        code,
        message,
    };
}

/** Integer moment selection without allocating a time grid. */
export function geometryTimeState(general = {}, index = 0) {
    const diagnostics = [];
    const count = general?.countTimeSteps ?? 0;
    const validCount = Number.isSafeInteger(count) && count >= 0;
    const maxIndex = validCount ? count : 0;
    if (!validCount) {
        diagnostics.push(warning("general", "countTimeSteps", "TIME_COUNT_INVALID",
            "Число интервалов времени должно быть неотрицательным целым числом. Доступен только момент 0."));
    }
    const currentIndex = Number.isFinite(index)
        ? Math.min(maxIndex, Math.max(0, Math.trunc(index)))
        : 0;
    const step = general?.timeStep ?? 0;
    const validStep = Number.isFinite(step) && (step > 0 || (maxIndex === 0 && step === 0));
    let time = 0;
    if (!validStep) {
        diagnostics.push(warning("general", "timeStep", "TIME_STEP_INVALID",
            "Шаг времени должен быть положительным конечным числом. Геометрия показана при t = 0."));
    } else {
        time = currentIndex * step;
        if (!Number.isFinite(time)) {
            time = 0;
            diagnostics.push(warning("general", "timeStep", "TIME_OVERFLOW",
                "Время выбранного момента выходит за допустимый числовой диапазон. Геометрия показана при t = 0."));
        }
    }
    return { index: currentIndex, maxIndex, time, diagnostics };
}

// Tables contain rows [time, ...components]. Validate their original order;
// changing it silently would hide an error in the task supplied to the solver.
function sampleTable(table, componentCount, time) {
    if (!Array.isArray(table) || table.length === 0) {
        return { error: "таблица пуста или отсутствует" };
    }
    for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
        const row = table[rowIndex];
        if (!Array.isArray(row) || row.length !== componentCount + 1
            || !row.every(Number.isFinite)) {
            return { error: `строка ${rowIndex + 1} должна содержать ${componentCount + 1} конечных чисел` };
        }
        if (rowIndex > 0 && row[0] <= table[rowIndex - 1][0]) {
            return { error: `время в строке ${rowIndex + 1} должно быть больше времени предыдущей строки` };
        }
    }
    if (!Number.isFinite(time)) return { error: "текущее время не является конечным числом" };
    if (time <= table[0][0]) return { values: table[0].slice(1) };
    const last = table.length - 1;
    if (time >= table[last][0]) return { values: table[last].slice(1) };

    let lower = 0;
    let upper = last;
    while (upper - lower > 1) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (table[middle][0] <= time) lower = middle;
        else upper = middle;
    }
    const left = table[lower];
    const right = table[upper];
    const interval = right[0] - left[0];
    const fraction = Number.isFinite(interval)
        ? (time - left[0]) / interval
        : (time / 2 - left[0] / 2) / (right[0] / 2 - left[0] / 2);
    // Weighted endpoints avoid overflow from right - left for large values.
    const values = left.slice(1).map((value, axis) => (
        fraction === 0 ? value : (1 - fraction) * value + fraction * right[axis + 1]
    ));
    return values.every(Number.isFinite)
        ? { values }
        : { error: "результат интерполяции выходит за допустимый числовой диапазон" };
}

function vector3(value) {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const vector = value.map(component => Array.isArray(component) ? component[0] : component);
    return vector.every(Number.isFinite) ? vector : null;
}

function copyVectorShape(original, values) {
    return values.map((value, axis) => Array.isArray(original[axis]) ? [value] : value);
}

/** Project element and region local frames; never accumulate previous motion. */
export function buildGeometryTimeModel(model = {}, moves = [], index = 0) {
    const state = geometryTimeState(model?.general, index);
    const diagnostics = [...state.diagnostics];
    const sampledMoves = new Map();
    let projected = model;
    for (const schemaId of ["elements", "regions"]) {
        const records = model?.[schemaId];
        if (!Array.isArray(records)) continue;
        let changedRecords = null;
        records.forEach((record, recordIndex) => {
            const reference = record?.indMove ?? 0;
            if (reference === 0) return;
            const report = (property, code, message) => diagnostics.push(warning(
                schemaId, property, code, `${message} Показано исходное положение.`, recordIndex,
            ));
            if (!Number.isSafeInteger(reference) || reference < 1
                || !Array.isArray(moves) || !moves[reference - 1]) {
                report("indMove", "MOTION_REFERENCE_INVALID", "Указана недоступная или некорректная траектория.");
                return;
            }
            if (!sampledMoves.has(reference)) {
                const move = moves[reference - 1];
                sampledMoves.set(reference, {
                    angle: sampleTable(move.angle, 3, state.time),
                    position: sampleTable(move.position, 3, state.time),
                });
            }
            const sampled = sampledMoves.get(reference);
            let invalidTable = false;
            for (const [property, label] of [["angle", "углов"], ["position", "положения"]]) {
                if (!sampled[property].error) continue;
                invalidTable = true;
                report("indMove", "MOTION_TABLE_INVALID",
                    `Траектория №${reference}, таблица ${label}: ${sampled[property].error}.`);
            }
            if (invalidTable) return;
            const originalAngle = vector3(record.symVi);
            const originalPosition = vector3(record.symR0);
            if (!originalAngle || !originalPosition) {
                report(!originalAngle ? "symVi" : "symR0", "MOTION_FRAME_INVALID",
                    "Исходные углы или положение локальной системы координат должны содержать три конечных числа.");
                return;
            }
            const angle = originalAngle.map((value, axis) => value + sampled.angle.values[axis]);
            const position = originalPosition.map((value, axis) => value + sampled.position.values[axis]);
            if (!angle.every(Number.isFinite) || !position.every(Number.isFinite)) {
                report("indMove", "MOTION_FRAME_OVERFLOW",
                    "Положение или углы перемещённой системы координат выходят за допустимый числовой диапазон.");
                return;
            }
            if (angle.every((value, axis) => value === originalAngle[axis])
                && position.every((value, axis) => value === originalPosition[axis])) return;
            changedRecords ??= [...records];
            changedRecords[recordIndex] = {
                ...record,
                symVi: copyVectorShape(record.symVi, angle),
                symR0: copyVectorShape(record.symR0, position),
            };
        });
        if (changedRecords) {
            if (projected === model) projected = { ...model };
            projected[schemaId] = changedRecords;
        }
    }
    return { ...state, model: projected, diagnostics };
}

/** Factors retain element indices; null suppresses an invalid source. */
export function sourceAmplitudeFactors(elements = [], amps = [], time = 0) {
    const diagnostics = [];
    const sampledAmplitudes = new Map();
    const factors = (Array.isArray(elements) ? elements : []).map((record, recordIndex) => {
        if (record?.targ !== 1 && record?.targ !== 2) return 1;
        const reference = record.indAmp ?? 0;
        if (reference === 0) return 1;
        const report = (code, message) => diagnostics.push(warning(
            "elements", "indAmp", code,
            `${message} Векторы заданного источника не показаны.`, recordIndex,
        ));
        if (!Number.isSafeInteger(reference) || reference < 1
            || !Array.isArray(amps) || !amps[reference - 1]) {
            report("SOURCE_AMPLITUDE_REFERENCE_INVALID", "Указана недоступная или некорректная амплитуда.");
            return null;
        }
        if (!sampledAmplitudes.has(reference)) {
            sampledAmplitudes.set(reference, sampleTable(amps[reference - 1].impuls, 1, time));
        }
        const sampled = sampledAmplitudes.get(reference);
        if (sampled.error) {
            report("SOURCE_AMPLITUDE_TABLE_INVALID", `Амплитуда №${reference}: ${sampled.error}.`);
            return null;
        }
        return sampled.values[0];
    });
    return { factors, diagnostics };
}
