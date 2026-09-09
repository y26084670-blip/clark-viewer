// services/solver/geometryKv.js
// Источник: julia, src/core/03_kv.jl, функция unpack(me::Kv). Снимок 2026-08.

const GRAD2RADIAN = Math.PI / 180;
const KV_VALIDATION_EPS = 0.03;

function difference(left, right) {
    return [
        left[0] - right[0],
        left[1] - right[1],
        left[2] - right[2],
    ];
}

function cross(left, right) {
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ];
}

function dot(left, right) {
    return left[0] * right[0]
        + left[1] * right[1]
        + left[2] * right[2];
}

function norm(vector) {
    return Math.hypot(vector[0], vector[1], vector[2]);
}

function isVertex(vertex) {
    return Array.isArray(vertex)
        && vertex.length === 3
        && Array.from(vertex).every(Number.isFinite);
}

function areParallel(left, right, tolerance) {
    return norm(cross(left, right)) < tolerance;
}

export const KV_GEO_FIELDS = {
    0: ["v1x","v1y","v1z","v2x","v2y","v2z","v3x","v3y","v3z","v4x","v4y","v4z",
        "v5x","v5y","v5z","v6x","v6y","v6z","v7x","v7y","v7z","v8x","v8y","v8z"],
    1: ["x1","r1","x2","r2","x3","r3","x4","r4","dvi"],
    2: ["Lx","Ly","Lz"],
    3: ["Hx","Ly","Lz","Ly2","Lz2"],
    4: ["L15","L37","Z037","DY","H","YV","ZV"],
};

export const KV_GEO_LENGTH = 24;   // zeros(REAL, 3 * 8)

// Эти геометрические критерии принадлежат preflight-валидации
// web-gui. solver получает уже подготовленные данные и не дублирует
// эту проверку.
// Нумерация вершин повторяет solver: нечётные вершины относятся к нижней
// грани, чётные — к верхней; рёбра 12, 34, 56 и 78 соединяют грани.
// Проверка применяется к вершинам после unpack для каждого geoType = 0…4.
// Отдельные признаки нужны для точной диагностики вместо общего сообщения.
export function validateKvVerticesDetailed(
    vertices,
    eps = KV_VALIDATION_EPS,
) {
    const checks = {
        edge13: false,
        edge57: false,
        edge15: false,
        edge37: false,
        edge26: false,
        parallel13And24: false,
        parallel57And68: false,
        parallel15And26: false,
        parallel37And26: false,
        parallel48And26: false,
        positiveVolume: false,
    };

    if (
        !Array.isArray(vertices)
        || vertices.length !== 8
        || !Array.from(vertices).every(isVertex)
        || !Number.isFinite(eps)
        || eps <= 0
    ) {
        return {
            valid: false,
            malformed: true,
            checks,
        };
    }

    const edge13 = difference(vertices[2], vertices[0]);
    const edge24 = difference(vertices[3], vertices[1]);
    const edge57 = difference(vertices[6], vertices[4]);
    const edge68 = difference(vertices[7], vertices[5]);
    const edge15 = difference(vertices[4], vertices[0]);
    const edge26 = difference(vertices[5], vertices[1]);
    const edge37 = difference(vertices[6], vertices[2]);
    const edge48 = difference(vertices[7], vertices[3]);
    const parallelTolerance = eps ** 2;

    checks.parallel13And24 = areParallel(
        edge13,
        edge24,
        parallelTolerance,
    );
    checks.parallel57And68 = areParallel(
        edge57,
        edge68,
        parallelTolerance,
    );
    checks.parallel15And26 = areParallel(
        edge15,
        edge26,
        parallelTolerance,
    );
    checks.parallel37And26 = areParallel(
        edge37,
        edge26,
        parallelTolerance,
    );
    checks.parallel48And26 = areParallel(
        edge48,
        edge26,
        parallelTolerance,
    );

    checks.edge13 = norm(edge13) > eps;
    checks.edge57 = norm(edge57) > eps;
    checks.edge15 = norm(edge15) > eps;
    checks.edge37 = norm(edge37) > eps;
    checks.edge26 = norm(edge26) > eps;

    checks.positiveVolume = dot(
        difference(vertices[1], vertices[0]),
        cross(
            difference(vertices[3], vertices[0]),
            edge15,
        ),
    ) > eps ** 3;

    return {
        valid: Object.values(checks).every(Boolean),
        malformed: false,
        checks,
    };
}

export function validateKvVertices(
    vertices,
    eps = KV_VALIDATION_EPS,
) {
    return validateKvVerticesDetailed(vertices, eps).valid;
}

// geo -> вершины [8][3] (kv38, локальная СК). Возврат { vertices, err }.
export function unpackKvVertices(geo, geoType) {
    const v = Array.from({ length: 8 }, () => [0, 0, 0]);
    let err = 0;

    // Шестигранник
    if (geoType === 0) {
        for (let k = 0; k < 8; k++) {
            v[k] = [geo[3 * k], geo[3 * k + 1], geo[3 * k + 2]];
        }
        return { vertices: v, err };
    }

    // Сектор
    if (geoType === 1) {
        const [x1, r1, x2, r2, x3, r3, x4, r4, dvi] = geo.slice(0, 9);
        const xsh = [x1, x2, x3, x4];
        const rsh = [r1, r2, r3, r4];
        const a = (dvi / 2) * GRAD2RADIAN;
        const TNG8 = Math.sin(a) / Math.cos(a);

        let kzz = 0;
        if (rsh[0] === rsh[1] && rsh[2] === rsh[3]) kzz = 1;
        if (xsh[0] === xsh[3] && xsh[1] === xsh[2]) kzz = 2;
        err = kzz === 0 ? 1 : 0;
        if (kzz === 1 && (rsh[1] >= rsh[2] || xsh[0] > xsh[1] || xsh[3] > xsh[2])) err = 2;
        if (kzz === 2 && xsh[3] >= xsh[1]) err = 21;
        if (kzz === 2 && rsh[0] > rsh[3]) err = 22;
        if (kzz === 2 && rsh[1] > rsh[2]) err = 23;
        if (err !== 0) kzz = 1;

        const MSE1 = [2, 6, 5, 1];
        const MSE2 = [7, 8, 6, 5];
        for (let i = 0; i <= 1; i++) {
            const rr = TNG8 * Math.pow(-1, i + kzz);
            for (let k = 0; k < 4; k++) {
                let m = kzz === 1 ? MSE1[k] + 2 * i : 0;
                if (kzz === 2) m = MSE2[k] - 4 * i;
                v[m - 1] = [xsh[k], rsh[k] * rr, rsh[k]];   // julia: 1-based m
            }
        }
        return { vertices: v, err };
    }

    // Прямоугольная призма
    if (geoType === 2) {
        const [Lx, Ly, Lz] = geo.slice(0, 3);
        err = Lx > 0 && Ly > 0 && Lz > 0 ? 0 : 1;
        for (const m of [2, 4, 6, 8]) v[m - 1][0] = Lx;
        for (const m of [1, 2, 3, 4]) v[m - 1][1] = Ly;
        for (const m of [3, 4, 7, 8]) v[m - 1][2] = Lz;
        return { vertices: v, err };
    }

    // Усечённая правильная пирамида
    if (geoType === 3) {
        const [Hx, Ly, Lz, Ly2, Lz2] = geo.slice(0, 5);
        err = Hx > 0 && Ly > 0 && Lz > 0 && Ly2 > 0 && Lz2 > 0
            ? 0
            : 1;
        for (const m of [1, 3, 5, 7]) v[m - 1][0] = 0;
        for (const m of [2, 4, 6, 8]) v[m - 1][0] = Hx;
        for (const m of [1, 3]) v[m - 1][1] = Ly;
        for (const m of [5, 7]) v[m - 1][1] = 0;
        for (const m of [2, 4]) v[m - 1][1] = (Ly + Ly2) / 2;
        for (const m of [6, 8]) v[m - 1][1] = (Ly - Ly2) / 2;
        for (const m of [1, 5]) v[m - 1][2] = 0;
        for (const m of [3, 7]) v[m - 1][2] = Lz;
        for (const m of [4, 8]) v[m - 1][2] = (Lz + Lz2) / 2;
        for (const m of [2, 6]) v[m - 1][2] = (Lz - Lz2) / 2;
        return { vertices: v, err };
    }

    // Неправильная пирамида
    if (geoType === 4) {
        const [L15, L37, Z037, DY, H, YV, ZV] = geo.slice(0, 7);
        err = L15 > 0 && L37 > 0 && DY > 0 ? 0 : 1;
        for (const m of [1, 3, 5, 7]) v[m - 1][0] = 0;
        for (const m of [2, 4, 6, 8]) v[m - 1][0] = -H;
        for (const m of [1, 5]) v[m - 1][1] = 0;
        for (const m of [3, 7]) v[m - 1][1] = DY;
        for (const m of [2, 4, 6, 8]) v[m - 1][1] = YV;
        v[0][2] = L15;
        v[4][2] = 0;
        v[2][2] = Z037 + L37;
        v[6][2] = Z037;
        for (const m of [2, 4, 6, 8]) v[m - 1][2] = ZV;
        return { vertices: v, err };
    }

    return { vertices: v, err: -1 };
}

// Обратное преобразование для geoType = 0 (не запрошено и не нужно)
export function packKvVertices(vertices) {
    const geo = new Array(KV_GEO_LENGTH).fill(0);
    for (let k = 0; k < 8; k++) {
        geo[3 * k] = vertices[k][0];
        geo[3 * k + 1] = vertices[k][1];
        geo[3 * k + 2] = vertices[k][2];
    }
    return geo;
}

// Смена варианта geo: состав позиций определяется geoType; переноса значений нет.
// Источник: julia, src/core/03_kv.jl::unpack — читает geo[1:k] по типу, хвост не используется.
export function resetKvGeo(geoType) {
    return new Array(KV_GEO_LENGTH).fill(0);
}
