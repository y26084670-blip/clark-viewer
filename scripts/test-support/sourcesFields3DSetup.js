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
  const cleanup = [];
  let requestSource, load;
  let state = { frame: null, requested: null, error: "", loading: false };
  const run = new Function("props", "createGeometryViewSetting", "createMemo", "onCleanup",
    "QUANTITIES", "resultDisplaySelection", "RESULT_LAYER_GROUPS", "createResultLayerReader", "useResultFrame",
    `${setup} return { quantities, requestedLayers, hasRequestedResults, hasVectors, hasScalars,
      resultLayers, statusLayers, layerStatus, timeIndex, selections }; } return SourcesFields3D(props);`);
  const api = run(props, options.createGeometryViewSetting ?? ((name, initial) => [() => settings[name] ?? initial, value => { settings[name] = value; }]),
    options.createMemo ?? (compute => compute), callback => cleanup.push(callback), QUANTITIES, resultDisplaySelection,
    RESULT_LAYER_GROUPS, options.readerFactory ?? createResultLayerReader,
    (source, reader) => { requestSource = source; load = reader; options.observeRequest?.(source); return () => state; });
  return { ...api, request: () => requestSource(), load: request => load(request),
    setResultState(next) { state = next; },
    close() { cleanup.splice(0).forEach(callback => callback()); } };
}
