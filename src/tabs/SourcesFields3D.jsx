import { createSignal, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { ResultsGeometryViewport } from "../components/geometry/ResultsGeometryViewport.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES } from "../services/results/resultMappings.js";
import { readObjectFrames, useAsyncResult } from "../services/results/resultRequests.js";
import { vectorScene } from "../services/results/resultPlots.js";

export function SourcesFields3D(props) {
  const [quantityKey, setQuantity] = createSignal("M");
  const [scale, setScale] = createSignal(1);
  const quantity = () => QUANTITIES[quantityKey()];
  const result = useAsyncResult(() => props.task && ({ task: props.task, quantityKey: quantityKey(),
    selected: quantity().group === "elements" ? props.elements : props.regions, time: props.time, budget: 5000 }), async request => {
    const frames = await readObjectFrames(request);
    return { scene: vectorScene(frames, QUANTITIES[request.quantityKey]), sampled: frames.some(x => x.frame.every > 1) };
  });
  return <div class="results-layout">
    <aside class="split-list-column">
      <ObjectList title="Элементы" records={props.task?.elements} selected={props.elements} onSelect={props.setElements} />
      <ObjectList title="Области" records={props.task?.regions} selected={props.regions} onSelect={props.setRegions} />
    </aside>
    <section class="plot-panel">
      <div class="plot-toolbar"><QuantitySelect options={["M", "H", "J", "E", "Bs", "As", "Bv", "Av"]} value={quantityKey()} onChange={setQuantity} />
        <label>Стрелки <input type="range" min="-1" max="1" step="0.05" value={Math.log10(scale())} onInput={event => setScale(10 ** event.currentTarget.valueAsNumber)} /></label>
      </div>
      <div class="plot-status" role="status">{result.loading() ? "Чтение результатов…" : result.error() || "Результаты в сохранённых узлах"}
        <Show when={result.value()}><span> · max {result.value().scene.maximumMagnitude.magnetization.toPrecision(6)} {quantity().unit}{result.value().sampled ? " · показана выборка узлов" : ""}</span></Show>
      </div>
      <div class="embedded-geometry">
        <ResultsGeometryViewport open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={props.time}
          selections={{ elements: props.elements.map(id => id - 1), regions: props.regions.map(id => id - 1) }}
          resultVectorScene={result.value()?.scene} resultVectorScale={scale()} resultPickingOnly={true}
          resultVectorColor={quantityKey() === "J" ? 0xff5454 : quantityKey() === "M" ? 0x44dd66 : 0x44bbff} />
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
