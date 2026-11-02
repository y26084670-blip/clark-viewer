// Number.toString keeps the decimal point independently of the browser locale.
export function formatSignificantNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toPrecision(digits)).toString() : "—";
}

// Selection belongs to the element/image/column, not to a rounded value or frame.
export function faceCurrentCellKey(elementId, image, column) {
  return `${elementId}:${image.ls}:${image.as}:${image.ps}:${column}`;
}

export function selectedFaceCurrentTotal(groups, selected) {
  let sum = 0, correction = 0;
  for (const element of groups) for (const image of element.images) {
    image.values.forEach((value, column) => {
      if (!Number.isFinite(value) || !selected.has(faceCurrentCellKey(element.id, image, column))) return;
      // Opposite currents may almost cancel; retain the small contributions.
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    });
  }
  return sum + correction;
}
