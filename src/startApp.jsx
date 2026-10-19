import { render } from "solid-js/web";
import App from "./App.jsx";
import "tabulator-tables/dist/css/tabulator_simple.min.css";
import "./App.css";

export function startApp(root) {
  return render(() => <App />, root);
}
