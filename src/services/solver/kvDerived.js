// Источник: julia, src/base/04_symmetry.jl::update_sym;
//           src/core/03_kv.jl (update, eoCount, eoCountAll, limits);
//           src/core/03_tk.jl::epCount. Снимок 2026-08.

// yc: указатели типа симметрии (SYMAdd.yc)
export function symYc(kya, kyp) {
    return [
        kya === 0 ? 1 : 0,      // yc1 — учитывать образы азимутальной симметрии
        kyp === 0 ? 1 : 0,      // yc2 — учитывать образы периодической симметрии
        kya < 0 ? -1 : 1,       // yc3 — знак азимутальных образов
        kyp < 0 ? -1 : 1,       // yc4 — знак периодических образов
    ];
}

function vectorFactor(vector, index, fallback = 1) {
    const item = vector?.[index];
    const value = Array.isArray(item) ? item[0] : item;

    return Number.isFinite(value) ? value : fallback;
}

function symmetryFactor(record, flatKey, nestedKey, fallback = 1) {
    const value =
        record?.[flatKey] ??
        record?.sym?.[nestedKey];

    return Number.isFinite(value) ? value : fallback;
}

// Число ЭО с независимыми источниками.
// Поддерживает плоские поля BaseModel схемы и вложенный solver-формат.
export function eoCount(record) {
    const yc = symYc(
        symmetryFactor(record, "symKya", "kya", 0),
        symmetryFactor(record, "symKyp", "kyp", 0),
    );

    return vectorFactor(record?.dp, 0)
        * vectorFactor(record?.dp, 1)
        * vectorFactor(record?.dp, 2)
        * symmetryFactor(record, "symLs", "ls")
        * (
            yc[0] === 0
                ? 1
                : symmetryFactor(record, "symAs", "as")
        )
        * (
            yc[1] === 0
                ? 1
                : symmetryFactor(record, "symPs", "ps")
        );
}

// Все геометрические образы.
export function eoCountAll(record) {
    return vectorFactor(record?.dp, 0)
        * vectorFactor(record?.dp, 1)
        * vectorFactor(record?.dp, 2)
        * symmetryFactor(record, "symLs", "ls")
        * symmetryFactor(record, "symAs", "as")
        * symmetryFactor(record, "symPs", "ps");
}

// Признаки материала: EnTARG = TARG(0), MAGNET(1), COIL(2), VIRTUAL(3)
export function kvFlags(kv = {}) {
    switch (kv.targ) {
        case 0: return {
            rv: (kv.rv ?? 0) > 0,
            mv: String(kv.xapName ?? "").trim().length > 0,
            ani: norm3(kv.vkan) > 0,
        };
        case 1: return { rv: false, mv: true,  ani: norm3(kv.vkan) > 0 };
        case 2: return { rv: true,  mv: false, ani: norm3(kv.vkan) > 0 };
        default: return { rv: false, mv: false, ani: false };
    }
}

function norm3(v) {
    if (!Array.isArray(v)) return 0;
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

// Число элементарных площадок ТК.
export function epCount(record) {
    return vectorFactor(record?.dp, 0)
        * vectorFactor(record?.dp, 1)
        * symmetryFactor(record, "symLs", "ls");
}

// Число узлов таблицы: фактическое число строк.
// Источник: julia, src/core/types.jl (Amplitude.n, Move.n) — n соответствует
// числу строк матрицы APPROX. Пересчитывается при изменении состава строк.
export function nodeCount(rows) {
    return Array.isArray(rows) ? rows.length : 0;
}