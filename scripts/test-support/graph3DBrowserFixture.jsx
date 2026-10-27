import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { WorkingPoints } from "/src/tabs/WorkingPoints.jsx";
import { SourcesFields3D } from "/src/tabs/SourcesFields3D.jsx";
import { graph3DTask } from "/scripts/test-support/graph3DFixture.js";
import { createGeometryViewSetting } from "/src/services/visualization/geometryViewSettings.js";
import "/src/App.css";
import "tabulator-tables/dist/css/tabulator.min.css";
for (const [key,value] of Object.entries({ resultElementsQuantity: "J", resultRegionsQuantity: "Bs", resultVirtualQuantity: "none", resultVectorColorMap: false,
  elementsMode: "all", regionsMode: "all", showLocalSymmetry: true, showPeriodicSymmetry: true, showMirrorSymmetry: true })) createGeometryViewSetting(key,value)[1](value);
function Fixture() {
  const f = graph3DTask(), [time,setTime] = createSignal(0), [mounted,setMounted] = createSignal(true), [busy,setBusy] = createSignal(false), [working,showWorking] = createSignal(false);
  const read = f.task.reader.read; let held = false, waiting = [];
  f.task.reader.read = async request => { if (held) await new Promise(resolve => waiting.push(resolve)); return read(request); };
  let capture;
  window.graphFixture = { ...f, setTime, setMounted, setBusy, showWorking, capture: () => capture,
    holdReads: () => { held = true; }, pendingReads: () => waiting.length,
    releaseReads: () => { held = false; waiting.splice(0).forEach(resolve => resolve()); } };
  const props = { task:f.task, elements:[1,2], regions:[1], setElements(){}, setRegions(){}, get time(){return time();}, setTime,
    get movieBusy(){return busy();}, registerMovieAdapter:adapter => { capture=adapter;return ()=>{}; } };
  return <div class="app-container"><header class="task-info-bar">Поверхности графиков — проверка</header>
    <main class="tabs-body"><Show when={mounted()}><Show when={working()} fallback={<SourcesFields3D {...props}/>}><WorkingPoints {...props}/></Show></Show></main></div>;
}
render(() => <Fixture/>, document.getElementById("root"));
