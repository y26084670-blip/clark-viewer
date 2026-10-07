from pathlib import Path
import json

def replace(path, before, after):
    p=Path(path); s=p.read_text()
    assert s.count(before)==1, (path,s.count(before),before[:80])
    p.write_text(s.replace(before,after))

replace('src/services/results/resultRequests.js','  if (mode !== OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED) return selected;','  if (mode === OBJECT_VISIBILITY_MODES.ALL) return records.map(record => record.id);\n  if (mode === OBJECT_VISIBILITY_MODES.NONE) return [];\n  if (mode !== OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED) return selected;')
replace('src/services/results/resultLayerDefinitions.js','label: "Виртуальные элементы"','label: "Виртуальные"')
replace('src/tabs/SourcesFields3D.jsx','import { createResultLayerReader } from "../services/results/resultLayerRequests.js";','import { createResultLayerReader } from "../services/results/resultLayerRequests.js";\nimport { applyResultGlobalRange, resultGlobalScale } from "../services/results/resultGlobalScale.js";')
replace('src/tabs/SourcesFields3D.jsx','  const [palette, setPalette] = createGeometryViewSetting("resultPalette", "Rainbow");','  const [palette, setPalette] = createGeometryViewSetting("resultPalette", "Rainbow");\n  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("resultGlobalMinMax", false);')
replace('src/tabs/SourcesFields3D.jsx','  const hasRequestedResults = createMemo(','''  const globalRanges = createMemo(() => resultGlobalScale(props.task, requestedLayers(), streamlineSeeds()));
  const effectiveGlobalMinMax = createMemo(() => globalMinMax() && globalRanges().available);
  const hasRequestedResults = createMemo(''')
replace('src/tabs/SourcesFields3D.jsx','    .map(line => ({ ...line, quantity:', '    .map(line => ({ ...line, displayRange: effectiveGlobalMinMax() ? globalRanges().lineRanges[line.quantityKey] : undefined, quantity:')
replace('src/tabs/SourcesFields3D.jsx','  const layerMetadata = layer => ({ ...layer,','  const layerMetadata = layer => ({ ...applyResultGlobalRange(layer, effectiveGlobalMinMax() ? globalRanges().layerRanges[layer.key] : null),')
replace('src/tabs/SourcesFields3D.jsx','    const range = scalar ? `${number(scalar.minimum)} … ${number(scalar.maximum)}` : `max ${number(maximum)}`;','''    const bounds = layer.displayRange;
    const range = bounds ? `${number(bounds.minimum)} … ${number(bounds.maximum)}`
      : scalar ? `${number(scalar.minimum)} … ${number(scalar.maximum)}` : `max ${number(maximum)}`;''')
replace('src/tabs/SourcesFields3D.jsx','      + volume + (layer.volumeNotice', '      + (bounds ? ` · общий минмакс${bounds.approximate ? " (произведение модулей)" : ""}` : "")\n      + volume + (layer.volumeNotice')
replace('src/tabs/SourcesFields3D.jsx',' /> Цветовая карта</label>',' /> Карта</label>')
replace('src/tabs/SourcesFields3D.jsx','        <label>Палитра <select', '''        <label class="source-global-minmax" title={globalRanges().available
          ? "Общие пределы модулей за весь расчёт из HDF5. Для энергии/потерь — произведения границ модулей."
          : globalRanges().reason}>
          <input type="checkbox" aria-label="Общий минмакс" checked={effectiveGlobalMinMax()}
            disabled={props.movieBusy || !globalRanges().available}
            onChange={event => !props.movieBusy && globalRanges().available && setGlobalMinMax(event.currentTarget.checked)} />Общий минмакс
        </label>
        <label>Палитра <select''')
replace('src/tabs/SourcesFields3D.jsx','        <Show when={streamlineNotice()}>','        <Show when={globalMinMax() && !globalRanges().available}><span>Общий минмакс недоступен: {globalRanges().reason}</span></Show>\n        <Show when={streamlineNotice()}>')
p=Path('src/tabs/SourcesFields3D.css');s=p.read_text().replace('gap: 6px 12px;', 'gap: 6px 8px;',1).replace('max-width: min(245px, 55vw);','max-width: min(205px, 45vw);')
s+='\n.sources-fields-toolbar > label { white-space: nowrap; }\n.sources-fields-toolbar .source-quantity-selector { flex-wrap: nowrap; }\n.sources-fields-toolbar .source-global-minmax { gap: 4px; }\n';p.write_text(s)
p='src/components/geometry/ThreeGeometryViewport.jsx'
replace(p,'  lengthReference = null,\n) {','  lengthReference = null,\n  displayRange = null,\n) {')
replace(p,'    const previous = root.getObjectByName("result-vector-color-nodes");','    if (displayRange) ({ minimum, maximum } = displayRange);\n    const previous = root.getObjectByName("result-vector-color-nodes");')
replace(p,'    const volumeFields = layer.volumeFields ?? null;','    const volumeFields = layer.volumeFields ?? null;\n    const displayRange = layer.displayRange?.available ? layer.displayRange : null;')
replace(p,'palette, opacity, layer.vectorLengthReference];','palette, opacity, layer.vectorLengthReference, displayRange];')
replace(p,'        updateResultVolumeMeshes(THREE, state.vectorRoot, domains,','        if (displayRange) ({ minimum, maximum } = displayRange);\n        updateResultVolumeMeshes(THREE, state.vectorRoot, domains,')
replace(p,'scene.maximumMagnitude, color, state.vectorRoot, palette, layer.vectorLengthReference);','scene.maximumMagnitude, color, state.vectorRoot, palette, layer.vectorLengthReference, displayRange);')
replace(p,'      const { minimum, maximum, quantity, unit } = scalarScene;','      const { quantity, unit } = scalarScene;\n      const { minimum, maximum } = displayRange ?? scalarScene;')
replace('src/services/visualization/resultStreamlineRenderer.js','  return ranges;\n}', '''  for (const line of lines) {
    const range = ranges.get(line.quantityKey ?? line.id), global = line.displayRange;
    if (range && global?.available) {
      range.minimum = global.minimum; range.maximum = global.maximum;
    }
  }
  return ranges;
}''')
p='scripts/test-support/sourcesFields3DSetup.js'
replace(p,'const streamlineSessions = new WeakMap();','import { applyResultGlobalRange, resultGlobalScale } from "../../src/services/results/resultGlobalScale.js";\n\nconst streamlineSessions = new WeakMap();')
replace(p,' Цветовая карта</label>',' Карта</label>')
replace(p,'"createMovieTabAdapter", "completedMovieFrame", "onMount",','"createMovieTabAdapter", "completedMovieFrame", "onMount", "applyResultGlobalRange", "resultGlobalScale",')
replace(p,'      resultLayers, statusLayers, layerStatus, timeIndex, selections };','      globalMinMax, setGlobalMinMax, globalRanges, effectiveGlobalMinMax, resultLayers, statusLayers, layerStatus, timeIndex, selections };')
replace(p,'options.completedMovieFrame, () => {});','options.completedMovieFrame, () => {}, applyResultGlobalRange, resultGlobalScale);')
replace('test/geometryRenderFilters.test.js','    for (const mode of ["all", "selected", "none", undefined]) {','    assert.deepEqual(resultDisplaySelection(records, selected, "all"), [2, 4, 8]);\n    assert.deepEqual(resultDisplaySelection(records, selected, "none"), []);\n    for (const mode of ["selected", undefined]) {')
replace('test/sourcesFields3D.test.js','"Виртуальные элементы"','"Виртуальные"')
replace('test/sourcesFields3D.test.js','set("resultPalette", "Turbo"); set("resultVectorScale", 2);','set("resultPalette", "Turbo"); set("resultVectorScale", 2);\n    set("resultGlobalMinMax", true); set("resultGlobalMinMax", false);')
for name in ['package.json','package-lock.json']:
    p=Path(name);x=json.loads(p.read_text());assert x['version']=='4.19.0';x['version']='4.20.0'
    if name=='package-lock.json': x['packages']['']['version']='4.20.0'
    p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
for target, addition in [('test/resultLayersRendering.test.js','.github/minmax-layer-tests.txt'),('test/resultStreamlineRendering.test.js','.github/minmax-streamline-tests.txt')]:
    p=Path(target);p.write_text(p.read_text()+Path(addition).read_text())
print('3D global minmax integration applied. Raw HDF5 readers, Solver, FieldLines and FieldAreas untouched.')
