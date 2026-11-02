import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { ElementFaceCurrentsDialog } from "../../src/components/ElementFaceCurrentsDialog.jsx";
import "../../src/App.css";

const pending = new Map();
let delayed = false;
const groups = step => Array.from({ length: 24 }, (_, index) => ({
  id: index + 1, name: `Элемент ${index + 1}`, dimensions: [3, 2, 3], layers: [[0, 2, 1], [0, 1, null], [0, 2, 1]],
  images: Array.from({ length: index === 0 ? 2 : 1 }, (_, image) => ({
    ls: image + 1, as: 1, ps: 1,
    values: [1.23456789, -1.2345, 0, -2.25, 1.23456789e-8, null, .00456789, 4, 5, null, null]
      .map(value => value === null ? null : value * (step + 1) * (image + 1)),
  })),
}));
const task = { name: "Проверка полных токов", general: { timeStep: .002 }, reader: {
  elementFaceCurrents(_task, step) {
    if (!delayed) return Promise.resolve(groups(step));
    return new Promise((resolve, reject) => pending.set(step, { resolve, reject }));
  },
} };

function Fixture() {
  let workspace;
  const [time, setTime] = createSignal(0), [opened, setOpened] = createSignal(false);
  window.faceCurrentsFixture = {
    step: setTime, delay: value => { delayed = value; }, pending: () => [...pending.keys()],
    resolve(step) { const item = pending.get(step); pending.delete(step); item.resolve(groups(step)); },
    reject(step) { const item = pending.get(step); pending.delete(step); item.reject(new Error(`Ошибка шага ${step}`)); },
  };
  return <>
    <div style={{ height: "60px", padding: "10px", "box-sizing": "border-box" }}>
      <button onClick={() => setOpened(true)}>Открыть инструмент</button>
    </div>
    <main ref={workspace} style={{ height: "calc(100dvh - 120px)", background: "#5c6977" }}>
      <Show when={opened()}>
        <ElementFaceCurrentsDialog task={task} time={time()} workspace={workspace} onClose={() => setOpened(false)} />
      </Show>
    </main>
  </>;
}
render(() => <Fixture />, document.getElementById("root"));
