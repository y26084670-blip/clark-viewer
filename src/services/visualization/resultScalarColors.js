// A shared sequential scale for saved scalar nodes and its browser legend.
// Values, including negative values, map monotonically from minimum to maximum.
const COLOR_STOPS = Object.freeze([
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
]);

export const RESULT_SCALAR_GRADIENT = `linear-gradient(to right, ${
  COLOR_STOPS.map((rgb, index) => `rgb(${rgb.join(", ")}) ${index * 25}%`).join(", ")
})`;

/** Returns an sRGB triplet in [0, 1]. A constant field uses the scale midpoint. */
export function resultScalarColor(value, minimum, maximum) {
  const span = maximum - minimum;
  const position = maximum > minimum
    ? Math.max(0, Math.min(1, Number.isFinite(span)
      ? (value - minimum) / span
      : (value / 2 - minimum / 2) / (maximum / 2 - minimum / 2)))
    : 0.5;
  const scaled = position * (COLOR_STOPS.length - 1);
  const first = Math.min(Math.floor(scaled), COLOR_STOPS.length - 2);
  const fraction = scaled - first;
  return COLOR_STOPS[first].map((component, index) => (
    component + (COLOR_STOPS[first + 1][index] - component) * fraction
  ) / 255);
}

/** A constant field has one color, including the common all-zero first frame. */
export function resultScalarLegendBackground(minimum, maximum) {
  return minimum === maximum
    ? `rgb(${resultScalarColor(minimum, minimum, maximum).map(value => Math.round(value * 255)).join(", ")})`
    : RESULT_SCALAR_GRADIENT;
}
