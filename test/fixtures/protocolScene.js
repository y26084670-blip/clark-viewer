export const general = { countTimeSteps: 0, timeStep: 0, doubleFloat: true, mirrorSymmetryX: 0, mirrorSymmetryY: 1 };
const sym = { vi: [0, 0, 0], r0: [0, 0, 0], yl: 90, ya: 60, tx: 5, ls: 2, as: 2, ps: 2, kya: 0, kyp: 0 };
export const elements = [{ name: "ВТСП <полоска>", geoType: 0,
  geo: [1, 1, 0, 1, 1, .2, 1, 2, 0, 1, 2, .2, 3, 1, 0, 3, 1, .2, 3, 2, 0, 3, 2, .2],
  sym, dr: [0, 0, 0], dp: [2, 2, 1], model: 2, targ: 0, rv: 1 }];
export const regions = [{ name: "Контрольная плоскость", geoType: 0, geo: [0, 0, 1, 0, 3, 1, 3, 3, 1, 3, 0, 1],
  sym: { ...sym, ls: 1 }, dr: [0, 0, 0], dp: [2, 2] }];
export const inputSummary = "Исходная система: ВТСП и контрольная плоскость\r\nПроверка <имён> & единиц\r\n";
export const outputSummary = "Расчёт завершён\r\nИтераций: 17\r\n\r\nФайлы результатов:\r\nMH.h5 — подробное описание\r\nJE.h5 — остальные данные\r\n";
