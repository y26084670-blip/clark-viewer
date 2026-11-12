import { installViewportGate } from "./viewportGate.js";
import "./viewportGate.css";
import { installTrafficTracking } from "./services/trafficService.js";

installTrafficTracking("viewer");

const root = document.getElementById("root");
const dispose = installViewportGate({
  root,
  applicationName: "E3D Viewer",
  load: () => import("./startApp.jsx").then(({ startApp }) => () => startApp(root)),
});

if (import.meta.hot) import.meta.hot.dispose(dispose);
