// Источник порядка преобразований: solver/model, анализ симметрий 2026-08.
// Индексы образов zero-based. Типы kya/kyp влияют на знак источника,
// но не сокращают число геометрических образов.

import {
    eulerRotationMatrix4,
    multiplyMatrix4,
    reflectionMatrix4,
    rotationXMatrix4,
    translationMatrix4,
} from "./rotation3d.js";

function vector3(value) {
    return [0, 1, 2].map(index => {
        const item = value?.[index];
        const number = Array.isArray(item) ? item[0] : item;
        return Number.isFinite(number) ? number : 0;
    });
}

function loopCount(value) {
    if (value === undefined || value === null) return 1;
    return Number.isInteger(value) && value > 0 ? value : 0;
}

function scalar(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function mirrorIndexes(setting) {
    return setting === 0 || setting === 1 ? [0, 1] : [0];
}

function alternatingSign(kind, index) {
    return kind < 0 && index % 2 === 1 ? -1 : 1;
}

function baseTransform(record, ls) {
    const [drX, drY, drZ] = vector3(record?.dr);
    const [viX, viY, viZ] = vector3(record?.symVi);
    const [r0X, r0Y, r0Z] = vector3(record?.symR0);
    const localAngle = ls * scalar(record?.symYl);

    return multiplyMatrix4(
        translationMatrix4(r0X, r0Y, r0Z),
        multiplyMatrix4(
            eulerRotationMatrix4(viX, viY, viZ),
            multiplyMatrix4(
                rotationXMatrix4(localAngle),
                translationMatrix4(drX, drY, drZ),
            ),
        ),
    );
}

export function expandElementSymmetry(record, general = {}) {
    const lsCount = loopCount(record?.symLs);
    const asCount = loopCount(record?.symAs);
    const psCount = loopCount(record?.symPs);

    if (lsCount === 0 || asCount === 0 || psCount === 0) return [];

    const mirrorYIndexes = mirrorIndexes(general?.mirrorSymmetryY);
    const mirrorXIndexes = mirrorIndexes(general?.mirrorSymmetryX);
    const axialAngle = scalar(record?.symYa);
    const periodicOffset = scalar(record?.symTx);
    const axialKind = scalar(record?.symKya);
    const periodicKind = scalar(record?.symKyp);
    const instances = [];

    // Вложенность решателя: LS → AS → PS → mirrorY → mirrorX.
    // Поэтому mirrorX является самым быстро меняющимся индексом.
    for (let ls = 0; ls < lsCount; ls++) {
        const local = baseTransform(record, ls);

        for (let as = 0; as < asCount; as++) {
            const axial = multiplyMatrix4(
                rotationXMatrix4(as * axialAngle),
                local,
            );

            for (let ps = 0; ps < psCount; ps++) {
                const periodic = multiplyMatrix4(
                    translationMatrix4(ps * periodicOffset, 0, 0),
                    axial,
                );

                for (const mirrorY of mirrorYIndexes) {
                    for (const mirrorX of mirrorXIndexes) {
                        instances.push({
                            matrix: multiplyMatrix4(
                                reflectionMatrix4(
                                    mirrorX === 1,
                                    mirrorY === 1,
                                ),
                                periodic,
                            ),
                            ls,
                            as,
                            ps,
                            mirrorX,
                            mirrorY,
                            axialSign: alternatingSign(axialKind, as),
                            periodicSign: alternatingSign(periodicKind, ps),
                        });
                    }
                }
            }
        }
    }

    return instances;
}

export function expandRegionSymmetry(record) {
    const lsCount = loopCount(record?.symLs);

    if (lsCount === 0) return [];

    return Array.from({ length: lsCount }, (_, ls) => ({
        matrix: baseTransform(record, ls),
        ls,
        as: 0,
        ps: 0,
        mirrorX: 0,
        mirrorY: 0,
        axialSign: 1,
        periodicSign: 1,
    }));
}
