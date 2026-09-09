// Источник: julia, src/task/01_counters.jl::evalCounters;
//           src/vsolver/04_mhj.jl::mhjRecall!;
//           src/core/03_kv.jl::limits. Снимок 2026-08.
//
// Вход функций — BaseModel elements: составные storageKey-поля имеют плоские
// имена symLs/symAs/...; dp представлен матрицей 3×1.

import { symYc } from "./kvDerived.js";

function records(kvs) {
    return Array.isArray(kvs) ? kvs : [];
}

function vectorItem(value, index, fallback = 1) {
    const row = value?.[index];

    return Array.isArray(row)
        ? (row[0] ?? fallback)
        : fallback;
}

function loopLimit(value) {
    return Number.isInteger(value) && value > 0
        ? value
        : 0;
}

// Границы циклов обхода ЭО одного ШГ (аналог TCore.limits).
export function kvLoopLimits(kv) {
    const yc = symYc(
        kv?.symKya ?? 0,
        kv?.symKyp ?? 0,
    );

    return {
        G1: loopLimit(vectorItem(kv?.dp, 0)),
        G2: loopLimit(vectorItem(kv?.dp, 1)),
        G3: loopLimit(vectorItem(kv?.dp, 2)),
        G6: loopLimit(kv?.symLs ?? 1),                 // LS
        G4: loopLimit(
            yc[0] === 1 ? (kv?.symAs ?? 1) : 1
        ),                                             // AS
        G5: loopLimit(
            yc[1] === 1 ? (kv?.symPs ?? 1) : 1
        ),                                             // PS
    };
}

function kvRowCount(kv) {
    const { G1, G2, G3, G6, G4, G5 } =
        kvLoopLimits(kv);

    return G1 * G2 * G3 * G6 * G4 * G5;
}

// Начальные индексы и число строк mhj для каждой записи elements
// с targ ∈ {MAGNET, COIL}.
export function mhjLayout(kvs) {
    const layout = [];
    let start = 0;

    records(kvs).forEach((kv, index) => {
        if (kv?.targ !== 1 && kv?.targ !== 2) return;

        const count = kvRowCount(kv);
        layout.push({
            kvIndex: index,
            name: kv?.name,
            start,
            count,
        });
        start += count;
    });

    return {
        rows: start,
        items: layout,
    };
}

// Пользовательский диапазон глобальных номеров ЭО с независимыми
// источниками для записи elements. Учитываются все физически
// предшествующие записи независимо от их назначения.
export function eoRange(kvs, kvIndex) {
    const source = records(kvs);

    if (
        !Number.isInteger(kvIndex) ||
        kvIndex < 0 ||
        kvIndex >= source.length
    ) {
        return "";
    }

    let start = 0;

    for (let index = 0; index < kvIndex; index++) {
        start += kvRowCount(source[index]);
    }

    const count = kvRowCount(source[kvIndex]);

    return count > 0
        ? `${start + 1}…${start + count}`
        : "";
}

// Проверка порядка записей: targ обязан не убывать.
export function isTargOrdered(kvs) {
    let previous = -1;

    for (const kv of records(kvs)) {
        if (kv?.targ < previous) return false;
        previous = kv?.targ;
    }

    return true;
}

// Строки таблицы mhj, но не более limit.
// Семь индексов повторяют вложенность mhjRecall!:
// KV → D12 → D13 → D15 → LS → AS → PS.
export function mhjRows(
    kvs,
    { limit = Number.POSITIVE_INFINITY } = {},
) {
    const rows = [];
    const rowLimit =
        Number.isInteger(limit) && limit >= 0
            ? limit
            : Number.POSITIVE_INFINITY;
    const source = records(kvs);

    if (rowLimit === 0) return rows;

    let globalOffset = 0;

    for (let kvIndex = 0; kvIndex < source.length; kvIndex++) {
        const kv = source[kvIndex];
        const globalStart = globalOffset;

        // Глобальная нумерация учитывает все физически предшествующие
        // записи elements независимо от их назначения.
        globalOffset += kvRowCount(kv);

        if (kv?.targ !== 1 && kv?.targ !== 2) continue;

        const { G1, G2, G3, G6, G4, G5 } =
            kvLoopLimits(kv);

        // Нулевая поздняя граница делает произведение пустым. Пропуск до
        // входа во внешние циклы не допускает бесполезного полного обхода.
        if ([G1, G2, G3, G6, G4, G5].some(value => value === 0)) {
            continue;
        }

        let eoLocal = 0;

        for (let d12 = 1; d12 <= G1; d12++) {
            for (let d13 = 1; d13 <= G2; d13++) {
                for (let d15 = 1; d15 <= G3; d15++) {
                    for (let ls = 1; ls <= G6; ls++) {
                        for (let as = 1; as <= G4; as++) {
                            for (let ps = 1; ps <= G5; ps++) {
                                eoLocal += 1;
                                rows.push({
                                    eoLocal,
                                    eoGlobal: globalStart + eoLocal,
                                    kv: kvIndex + 1,
                                    d12,
                                    d13,
                                    d15,
                                    ls,
                                    as,
                                    ps,
                                    targ: kv.targ,
                                });

                                if (rows.length >= rowLimit) {
                                    return rows;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return rows;
}

// Требуемое число строк значения v.
export function mhjRowCount(kvs) {
    return records(kvs).reduce(
        (total, kv) =>
            kv?.targ === 1 || kv?.targ === 2
                ? total + kvRowCount(kv)
                : total,
        0,
    );
}
