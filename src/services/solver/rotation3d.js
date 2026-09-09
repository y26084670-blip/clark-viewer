// Чистая математика аффинных преобразований для визуализации геометрии.
// Матрицы хранятся в column-major порядке, совместимом с THREE.Matrix4,
// и умножаются на векторы-столбцы.

const DEGREE_TO_RADIAN = Math.PI / 180;

export function identityMatrix4() {
    return new Float64Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

// Возвращает left * right.
export function multiplyMatrix4(left, right) {
    const result = new Float64Array(16);

    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            let value = 0;

            for (let index = 0; index < 4; index++) {
                value += left[index * 4 + row]
                    * right[column * 4 + index];
            }

            result[column * 4 + row] = value;
        }
    }

    return result;
}

export function translationMatrix4(x = 0, y = 0, z = 0) {
    const result = identityMatrix4();
    result[12] = x;
    result[13] = y;
    result[14] = z;
    return result;
}

export function rotationXMatrix4(angleDegrees = 0) {
    const angle = angleDegrees * DEGREE_TO_RADIAN;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    return new Float64Array([
        1, 0, 0, 0,
        0, cosine, sine, 0,
        0, -sine, cosine, 0,
        0, 0, 0, 1,
    ]);
}

export function rotationYMatrix4(angleDegrees = 0) {
    const angle = angleDegrees * DEGREE_TO_RADIAN;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    return new Float64Array([
        cosine, 0, -sine, 0,
        0, 1, 0, 0,
        sine, 0, cosine, 0,
        0, 0, 0, 1,
    ]);
}

export function rotationZMatrix4(angleDegrees = 0) {
    const angle = angleDegrees * DEGREE_TO_RADIAN;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    return new Float64Array([
        cosine, sine, 0, 0,
        -sine, cosine, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

// Порядок решателя: R(vi) = Rz(vi.z) * Ry(vi.y) * Rx(vi.x).
export function eulerRotationMatrix4(x = 0, y = 0, z = 0) {
    return multiplyMatrix4(
        rotationZMatrix4(z),
        multiplyMatrix4(
            rotationYMatrix4(y),
            rotationXMatrix4(x),
        ),
    );
}

export function reflectionMatrix4(reflectX = false, reflectY = false) {
    const result = identityMatrix4();
    result[0] = reflectX ? -1 : 1;
    result[5] = reflectY ? -1 : 1;
    return result;
}

export function applyMatrix4ToPoint(matrix, point) {
    const x = point?.[0] ?? 0;
    const y = point?.[1] ?? 0;
    const z = point?.[2] ?? 0;
    const w = matrix[3] * x + matrix[7] * y
        + matrix[11] * z + matrix[15];
    const divisor = w === 0 ? 1 : w;

    return [
        (matrix[0] * x + matrix[4] * y
            + matrix[8] * z + matrix[12]) / divisor,
        (matrix[1] * x + matrix[5] * y
            + matrix[9] * z + matrix[13]) / divisor,
        (matrix[2] * x + matrix[6] * y
            + matrix[10] * z + matrix[14]) / divisor,
    ];
}
