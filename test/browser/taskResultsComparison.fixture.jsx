import { render } from "solid-js/web";
import App from "../../src/App.jsx";

const root = await navigator.storage.getDirectory();
const disk = await root.getDirectoryHandle("comparison-disk", { create: true });
const catalog = await disk.getDirectoryHandle("clark.projects", { create: true });
for (const [index, projectName, taskName] of [[1, "Project2", "A"], [2, "Project10", "B"]]) {
  const project = await catalog.getDirectoryHandle(projectName, { create: true });
  const task = await project.getDirectoryHandle(taskName, { create: true });
  const output = await task.getDirectoryHandle("output3XX", { create: true });
  for (const name of ["JE.h5", "HS.h5", "MH.h5", "Q.h5", "bad.h5", ...(index === 1 ? ["PSI.h5"] : [])]) {
    const response = await fetch(`/__comparison-data/${index}/${name}`);
    if (!response.ok) throw new Error(`Fixture H5: ${response.status} ${response.url}`);
    const writer = await (await output.getFileHandle(name, { create: true })).createWritable();
    await writer.write(await response.arrayBuffer()); await writer.close();
  }
  const writer = await (await output.getFileHandle("timing.txt", { create: true })).createWritable();
  await writer.write(`   idtk            время (с)  матрица (мин)  источники (мин)   поле (мин)\n      0                  0.0         999.000           888.000      777.000\n\n${index === 1 ? "Итого за расчет:\n" : ""}Полное время (мин): ${index}\nМатрица (мин): ${index}.1\nРасчет источников (мин): ${index}.2\nРасчет поля (мин): ${index}.3\n`);
  await writer.close();
}
window.showDirectoryPicker = async () => disk;
localStorage.setItem("e3d.generalInformation.openAtStartup", "false");
render(() => <App />, document.getElementById("root"));
window.comparisonFixture = { ready: true };
