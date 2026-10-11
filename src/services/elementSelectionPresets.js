import { classifyGeometryMaterial, GEOMETRY_MATERIAL_KINDS as K } from "./visualization/geometryMaterialStyle.js";

export const ELEMENT_SELECTION_PRESETS = Object.freeze([
  { key: "M", label: "M", title: "Выделить все элементы с неизвестной намагниченностью" },
  { key: "M0", label: "M₀", title: "Выделить все элементы с заданной намагниченностью" },
  { key: "J", label: "J", title: "Выделить все элементы с неизвестной плотностью тока" },
  { key: "J0", label: "J₀", title: "Выделить все элементы с заданной плотностью тока" },
  { key: "Virt", label: "Virt", title: "Выделить все виртуальные элементы" },
]);

const kinds = {
  M: new Set([K.FMM_INSULATING, K.FMM_CONDUCTIVE, K.HTSC_MAGNETIC, K.HTSC_BOTH]),
  M0: new Set([K.PRESCRIBED_MAGNETIZATION]),
  J: new Set([K.FMM_CONDUCTIVE, K.NONMAGNETIC_CONDUCTIVE, K.HTSC_CURRENT, K.HTSC_BOTH]),
  J0: new Set([K.PRESCRIBED_CURRENT]),
  Virt: new Set([K.VIRTUAL]),
};

// Use the same physical categories as the material legend, including HTS
// subsystem flags. Select the complete record set, not just rendered rows.
export function selectElementPreset(records = [], general = {}, key) {
  const accepted = kinds[key];
  return accepted ? records.filter(record => accepted.has(classifyGeometryMaterial(record, general)))
    .map(record => record.id) : [];
}
