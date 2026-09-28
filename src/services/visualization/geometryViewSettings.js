import { createSignal } from "solid-js";

// Настройки принадлежат открытой странице, а не заданию или владельцу компонента.
// Только скалярные опции: здесь не храним модели, выделение, время и ресурсы WebGL.
const settings = new Map();

export function createGeometryViewSetting(name, initialValue) {
  if (!settings.has(name)) settings.set(name, createSignal(initialValue));
  return settings.get(name);
}
