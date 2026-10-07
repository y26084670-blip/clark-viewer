// Independent 3D result groups; geometry visibility and list selection are separate.
export const RESULT_LAYER_GROUPS = Object.freeze([
  Object.freeze({ key: "elements", label: "Элементы", defaultQuantity: "M",
    quantities: Object.freeze(["none", "M", "H", "MHdot", "J", "E", "JEdot"]) }),
  Object.freeze({ key: "regions", label: "Области", defaultQuantity: "none",
    quantities: Object.freeze(["none", "Bs", "As"]) }),
  Object.freeze({ key: "virtual", label: "Виртуальные", defaultQuantity: "none",
    quantities: Object.freeze(["none", "Bv", "Av"]) }),
]);

export const RESULT_LAYER_QUANTITY_LABELS = Object.freeze({
  none: "Не показывать",
  M: "Намагниченность", H: "Напряженность МП", MHdot: "Плотность энергии ФММ",
  J: "Плотность тока", E: "Напряженность ЭП", JEdot: "Потери на токи проводимости",
  Bs: "Индукция", As: "Векторный потенциал",
  Bv: "Индукция", Av: "Векторный потенциал",
});
