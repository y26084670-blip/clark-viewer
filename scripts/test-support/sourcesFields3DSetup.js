import { readFileSync } from "node:fs";
import { QUANTITIES, assignedHtsElements } from "../../src/services/results/resultMappings.js";
import { resultDisplaySelection } from "../../src/services/results/resultRequests.js";
import { RESULT_LAYER_GROUPS } from "../../src/services/results/resultLayerDefinitions.js";
import { createResultLayerReader } from "../../src/services/results/resultLayerRequests.js";
import { STREAMLINE_DEFAULT_TOLERANCE, STREAMLINE_LIMITS, STREAMLINE_METHODS } from "../../src/services/visualization/resultStreamlineField.js";

import { applyResultGlobalRange, resultGlobalScale } from "../../src/services/results/resultGlobalScale.js";

const streamlineSessions = new WeakMap();
const cameraSessions = new WeakMap();

// Execute the actual component setup, excluding JSX. Memo reads are evaluated on
// demand and only lifecycle/frame-hook adapters are replaced; this verifies the
// request and display logic, not Solid's reactive scheduler or a browser DOM.
export function sourcesFields3DSetup(props, settings = {}, options = {}) {
  const source = readFileSync(new URL("../../src/tabs/SourcesFields3D.jsx", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf("export function SourcesFields3D"), source.indexOf("  return <div"))
    .replace("export function", "function");
  // Expose the production setup state without depending on the exact JSX menu
  // markup. The compact toolbar is tested separately as a source/UI contract.
  const controlBindings = `() => ({
    visible: hasVectors() || hasScalars(),
    label: "Размер",
    sliderValue: Math.log10(scale()),
    onInput: event => setScale(10 ** event.currentTarget.valueAsNumber),
    checked: effectiveColorMap(),
    disabled: hasScalars(),
    onChange: event => changeColorMap(event.currentTarget.checked),
    viewportColorMap: effectiveColorMap(),
  })`;
  const streamlineBindings = `() => ({
    method: streamlineMethod(),
    methodOptions: Object.entries(STREAMLINE_METHODS),
    methodDisabled: props.movieBusy,
    onMethodChange: changeStreamlineMethod,
    width: streamlineWidth(),
    onWidthInput: event => setStreamlineWidth(event.currentTarget.valueAsNumber),
    colorMap: true,
    viewportWidth: streamlineWidth(),
    viewportColorMap: true,
  })`;
  const cleanup = [];
  const effects = [];
  let requestSource, load;
  let state = { frame: null, requested: null, error: "", loading: false };
  const run = new Function("props", "createGeometryViewSetting", "createMemo", "onCleanup", "createSignal", "createEffect",
    "STREAMLINE_DEFAULT_TOLERANCE", "STREAMLINE_LIMITS", "STREAMLINE_METHODS", "streamlineSessions", "cameraSessions",
    "QUANTITIES", "assignedHtsElements", "resultDisplaySelection", "RESULT_LAYER_GROUPS", "createResultLayerReader", "useResultFrame",
    "createMovieTabAdapter", "completedMovieFrame", "onMount", "applyResultGlobalRange", "resultGlobalScale",
    `${setup} return { cameraState, rememberCamera, quantities, requestedLayers, hasRequestedResults, hasVectors, hasScalars,
      colorMap, effectiveColorMap, normalizeVectors, changeNormalizeVectors, changeColorMap, conductivityAvailable, unavailableConductivity, scale, streamlineSeeds, selectedStreamline, setSelectedStreamline,
      addStreamline, deleteStreamline, streamlineMethod, changeStreamlineMethod, streamlines,
      controls: ${controlBindings},
      streamlineControls: ${streamlineBindings},
      globalMinMax, setGlobalMinMax, globalRanges, effectiveGlobalMinMax, resultLayers, timeIndex, selections }; } return SourcesFields3D(props);`);
  const api = run(props, options.createGeometryViewSetting ?? ((name, initial) => [() => settings[name] ?? initial, value => { settings[name] = value; }]),
    options.createMemo ?? (compute => compute), callback => cleanup.push(callback),
    options.createSignal ?? (initial => { let value = initial; return [() => value, next => { value = typeof next === "function" ? next(value) : next; }]; }),
    options.createEffect ?? (callback => { effects.push(callback); callback(); }),
    STREAMLINE_DEFAULT_TOLERANCE, STREAMLINE_LIMITS, STREAMLINE_METHODS, streamlineSessions, cameraSessions, QUANTITIES, assignedHtsElements, resultDisplaySelection,
    RESULT_LAYER_GROUPS, options.readerFactory ?? createResultLayerReader,
    (source, reader) => { requestSource = source; load = reader; options.observeRequest?.(source); return () => state; },
    options.createMovieTabAdapter ?? (() => ({ onCaptureReady() {} })), options.completedMovieFrame, () => {}, applyResultGlobalRange, resultGlobalScale);
  return { ...api, request: () => requestSource(), load: request => load(request),
    setResultState(next) { state = next; },
    flushEffects() { effects.forEach(callback => callback()); },
    close() { cleanup.splice(0).forEach(callback => callback()); } };
}
