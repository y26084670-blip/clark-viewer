import { readFileSync } from "node:fs";
import { QUANTITIES } from "../../src/services/results/resultMappings.js";
import { resultDisplaySelection } from "../../src/services/results/resultRequests.js";
import { RESULT_LAYER_GROUPS } from "../../src/services/results/resultLayerDefinitions.js";
import { createResultLayerReader } from "../../src/services/results/resultLayerRequests.js";

// Execute the actual component setup, excluding JSX. Memo reads are evaluated on
// demand and only lifecycle/frame-hook adapters are replaced; this verifies the
// request and display logic, not Solid's reactive scheduler or a browser DOM.
export function sourcesFields3DSetup(props, settings = {}, options = {}) {
  const source = readFileSync(new URL("../../src/tabs/SourcesFields3D.jsx", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf("export function SourcesFields3D"), source.indexOf("  return <div"))
    .replace("export function", "function");
  // Evaluate the production JSX bindings and callbacks in that same setup
  // closure, so the tests also observe checkbox state/guards and slider wiring.
  const controls = source.slice(source.indexOf("<Show when={hasVectors()"), source.indexOf(" Цветовая карта</label>"));
  const visible = controls.match(/<Show when=\{([^\n]+)\}>/);
  const label = controls.match(/<label>\{([^\n}]+)\}/);
  const range = controls.match(/<input type="range" ([^\n]+) \/>/);
  const checkbox = controls.match(/<input type="checkbox" ([^\n]+) \/>/);
  if (!visible || !label || !range || !checkbox) throw new Error("3D result size controls were not found");
  const binding = (text, name) => {
    const value = text.match(new RegExp(`${name}=\\{([^}]+)\\}`));
    if (!value) throw new Error(`3D control binding ${name} was not found`);
    return value[1];
  };
  const controlBindings = `() => ({ visible: ${visible[1]}, label: ${label[1]},
    sliderValue: ${binding(range[1], "value")}, onInput: ${binding(range[1], "onInput")},
    checked: ${binding(checkbox[1], "checked")}, disabled: ${binding(checkbox[1], "disabled")},
    onChange: ${binding(checkbox[1], "onChange")},
    viewportColorMap: ${binding(source, "resultVectorColorMap")} })`;
  const cleanup = [];
  let requestSource, load;
  let state = { frame: null, requested: null, error: "", loading: false };
  const run = new Function("props", "createGeometryViewSetting", "createMemo", "onCleanup",
    "QUANTITIES", "resultDisplaySelection", "RESULT_LAYER_GROUPS", "createResultLayerReader", "useResultFrame",
    "createMovieTabAdapter", "completedMovieFrame",
    `${setup} return { quantities, requestedLayers, hasRequestedResults, hasVectors, hasScalars,
      colorMap, effectiveColorMap, palette, scale,
      controls: ${controlBindings},
      resultLayers, statusLayers, layerStatus, timeIndex, selections }; } return SourcesFields3D(props);`);
  const api = run(props, options.createGeometryViewSetting ?? ((name, initial) => [() => settings[name] ?? initial, value => { settings[name] = value; }]),
    options.createMemo ?? (compute => compute), callback => cleanup.push(callback), QUANTITIES, resultDisplaySelection,
    RESULT_LAYER_GROUPS, options.readerFactory ?? createResultLayerReader,
    (source, reader) => { requestSource = source; load = reader; options.observeRequest?.(source); return () => state; },
    options.createMovieTabAdapter ?? (() => ({ onCaptureReady() {} })), options.completedMovieFrame);
  return { ...api, request: () => requestSource(), load: request => load(request),
    setResultState(next) { state = next; },
    close() { cleanup.splice(0).forEach(callback => callback()); } };
}
