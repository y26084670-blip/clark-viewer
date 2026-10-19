import { installViewportGate } from "./viewportGate.js";
import "./viewportGate.css";

const root = document.getElementById("root");
const dispose = installViewportGate({
  root,
  applicationName: "E3D Viewer",
  load: () => import("./startApp.jsx").then(({ startApp }) => () => startApp(root)),
});

if (import.meta.hot) import.meta.hot.dispose(dispose);
