//==============================================================================
// Форма значения ARRAY — единственное описание.
//
// Уровни представления одного и того же значения:
//   StorageModel — плоское значение, формально 1×N;
//   BaseModel    — массив строк, строка — массив значений;
//   ViewModel    — объект строки представления с ключами c0…cN.
//
// Модуль получает дескриптор свойства и значения.
// Он не читает схему целиком, не обращается к Tabulator и не строит UI.
//==============================================================================

const COLUMN_KEY_PREFIX = "c";

export const ARRAY_ORDERS = Object.freeze({
    COLUMN: "column",
    ROW: "row",
});

// Объявлена ли форма матрицы: число колонок задано дескриптором.
export function hasMatrixShape(property) {
    return Boolean(property?.nColumns);
}

// Число колонок значения. По умолчанию — одна.
export function columnCount(property) {
    return property?.nColumns ?? 1;
}

// Ориентация плоского хранения. Существующие схемы по умолчанию column-major.
export function arrayOrder(property) {
    return property?.order ?? ARRAY_ORDERS.COLUMN;
}

export function isArrayOrder(order) {
    return order === undefined ||
        Object.values(ARRAY_ORDERS).includes(order);
}

// StorageModel -> BaseModel с ориентацией из дескриптора.
export function fromStorage(flat, property) {
    const columns = columnCount(property);

    switch (arrayOrder(property)) {
        case ARRAY_ORDERS.COLUMN:
            return fromColumnMajor(flat, columns);
        case ARRAY_ORDERS.ROW:
            return fromRowMajor(flat, columns);
        default:
            throw new Error(
                `Unsupported ARRAY order '${property?.order}'`
            );
    }
}

// BaseModel -> StorageModel с ориентацией из дескриптора.
export function toStorage(rows, property) {
    const columns = columnCount(property);

    switch (arrayOrder(property)) {
        case ARRAY_ORDERS.COLUMN:
            return toColumnMajor(rows, columns);
        case ARRAY_ORDERS.ROW:
            return toRowMajor(rows, columns);
        default:
            throw new Error(
                `Unsupported ARRAY order '${property?.order}'`
            );
    }
}

// Имя поля ячейки представления по номеру колонки.
export function columnKey(index) {
    return `${COLUMN_KEY_PREFIX}${index}`;
}

// StorageModel -> BaseModel: плоский column-major -> массив строк.
export function fromColumnMajor(flat, nColumns) {
    if (!Array.isArray(flat)) return [];

    const columns = nColumns > 0 ? nColumns : 1;
    const nRows = Math.ceil(flat.length / columns);
    const rows = [];

    for (let row = 0; row < nRows; row++) {
        const values = [];
        for (let column = 0; column < columns; column++) {
            const index = row + column * nRows;
            values.push(
                index < flat.length
                    ? flat[index]
                    : null
            );
        }
        rows.push(values);
    }

    return rows;
}

// BaseModel -> StorageModel: массив строк -> плоский column-major.
export function toColumnMajor(rows, nColumns) {
    if (!Array.isArray(rows)) return rows;

    const columns = nColumns > 0 ? nColumns : 1;
    const flat = [];

    for (let column = 0; column < columns; column++) {
        for (let row = 0; row < rows.length; row++) {
            flat.push(rows[row]?.[column] ?? null);
        }
    }

    return flat;
}

// StorageModel -> BaseModel: последовательные группы образуют строки.
export function fromRowMajor(flat, nColumns) {
    if (!Array.isArray(flat)) return [];

    const columns = nColumns > 0 ? nColumns : 1;
    const nRows = Math.ceil(flat.length / columns);
    const rows = [];

    for (let row = 0; row < nRows; row++) {
        const values = [];
        for (let column = 0; column < columns; column++) {
            const index = row * columns + column;
            values.push(
                index < flat.length
                    ? flat[index]
                    : null
            );
        }
        rows.push(values);
    }

    return rows;
}

// BaseModel -> StorageModel: строки записываются последовательно.
export function toRowMajor(rows, nColumns) {
    if (!Array.isArray(rows)) return rows;

    const columns = nColumns > 0 ? nColumns : 1;
    const flat = [];

    for (let row = 0; row < rows.length; row++) {
        for (let column = 0; column < columns; column++) {
            flat.push(rows[row]?.[column] ?? null);
        }
    }

    return flat;
}

// Строка значений -> ячейки строки представления.
export function valuesToCells(values) {
    const cells = {};

    if (!Array.isArray(values)) return cells;

    values.forEach((value, column) => {
        cells[columnKey(column)] = value;
    });

    return cells;
}

// Ячейки строки представления -> строка значений.
// Состав определяется дескриптором, а не набором полей строки Tabulator.
export function cellsToValues(row, nColumns) {
    const columns = nColumns > 0 ? nColumns : 1;
    const values = [];

    for (let column = 0; column < columns; column++) {
        values.push(row?.[columnKey(column)] ?? null);
    }

    return values;
}
