// services/solver/geometryTk.js
// Источник: julia, src/core/03_tk.jl, функции unpack(me::Tk), update(me::Tk). Снимок 2026-08.
const GRAD2RADIAN = Math.PI / 180;

export const TK_GEO_FIELDS = {
    0: ["v1x","v1y","v1z","v2x","v2y","v2z","v3x","v3y","v3z","v4x","v4y","v4z"],
    1: ["R1","R2","dvi","H"],
    2: ["xA","yA","zA","xB","yB","zB"],
    3: ["L","H"],
};

export const TK_GEO_LENGTH = 12;   // zeros(REAL, 3 * 4)

export function unpackTkVertices(geo, geoType) {
    const v = Array.from({ length: 4 }, () => [0, 0, 0]);
    let err = 0;

    // Площадка
    if (geoType === 0) {
        for (let k = 0; k < 4; k++) {
            v[k] = [geo[3 * k], geo[3 * k + 1], geo[3 * k + 2]];
        }
        return { vertices: v, err };
    }

    // Сектор
    if (geoType === 1) {
        const [R1, R2, dvi, H] = geo.slice(0, 4);
        err = R1 > 0 && R2 > 0 && H > 0 && dvi > 0 ? 0 : 1;
        const a = (dvi / 2) * GRAD2RADIAN;
        const TNG8 = Math.sin(a) / Math.cos(a);
        v[0][0] = 0; v[3][0] = 0; v[1][0] = H; v[2][0] = H;
        v[0][1] = R1 * TNG8; v[3][1] = -v[0][1];
        v[1][1] = R2 * TNG8; v[2][1] = -v[1][1];
        v[0][2] = R1; v[3][2] = R1; v[1][2] = R2; v[2][2] = R2;
        return { vertices: v, err };
    }

    // Отрезок
    if (geoType === 2) {
        const [xA, yA, zA, xB, yB, zB] = geo.slice(0, 6);
        v[0] = [xA, yA, zA]; v[1] = [xA, yA, zA];
        v[2] = [xB, yB, zB]; v[3] = [xB, yB, zB];
        return { vertices: v, err };
    }

    // Прямоугольник
    if (geoType === 3) {
        const [L, H] = geo.slice(0, 2);
        err = L > 0 && H > 0 ? 0 : 2;
        v[2][1] = L; v[3][1] = L;
        v[1][2] = H; v[2][2] = H;
        return { vertices: v, err };
    }
    return { vertices: v, err: -1 };
}

export function packTkVertices(vertices) {
    const geo = new Array(TK_GEO_LENGTH).fill(0);
    for (let k = 0; k < 4; k++) {
        geo[3 * k] = vertices[k][0];
        geo[3 * k + 1] = vertices[k][1];
        geo[3 * k + 2] = vertices[k][2];
    }
    return geo;
}

// Раскрытие сектора: производная величина решателя.
// Источник: julia, src/core/03_tk.jl, функция update(me::Tk): me.vi4AC1 = me.self.geo[3]
export function tkVi4AC1(geo) {
    return geo?.[2] ?? 0;
}

// Смена варианта geo: позиции имеют несовместимую семантику, поэтому весь буфер обнуляется.
// Источник: julia, src/core/03_tk.jl::unpack — читает geo[1:k] по типу, хвост буфера не используется.
export function resetTkGeo(geoType) {
    return new Array(TK_GEO_LENGTH).fill(0);
}
