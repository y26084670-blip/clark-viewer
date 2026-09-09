import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { buildGeometryScene } from "../../services/visualization/geometrySceneModel.js";
import {
  buildGeometryTimeModel,
  geometryTimeState,
  sourceAmplitudeFactors,
} from "../../services/visualization/geometryTimeModel.js";
import {
  buildSourceVectorScene,
  SOURCE_VECTOR_LIMIT,
} from "../../services/visualization/sourceVectorSceneModel.js";
import {
  GEOMETRY_CAMERA_COMMANDS,
  geometryCameraCommandFromKeyboardEvent,
  isGeometryCameraShortcutTarget,
} from "../../services/visualization/geometryCameraView.js";
import {
  GEOMETRY_INSTANCE_BUDGET,
  ThreeGeometryViewport,
} from "./ThreeGeometryViewport.jsx";
import "./ResultsGeometryViewport.css";

const EMPTY_COUNTS = Object.freeze({
  elements: 0,
  regions: 0,
  primitives: 0,
  instances: 0,
  vertices: 0,
  triangles: 0,
  lines: 0,
  skipped: 0,
});

const EMPTY_RENDER_STATS = Object.freeze({
  discretizationLineSegments: 0,
  discretizationPoints: 0,
  discretizationTruncated: false,
  renderedInstances: 0,
  renderedPrimitives: 0,
  selectedInstances: 0,
  truncated: false,
});

const DIAGNOSTIC_REASONS = Object.freeze({
  "instance-budget-exceeded": "превышен лимит образов",
  "invalid-geometry": "неполные или нечисловые координаты геометрии",
  "invalid-discretization": "слой дискретизации недоступен",
  "invalid-symmetry": "некорректное число образов симметрии",
  "invalid-transform": "некорректное преобразование",
  "scene-conversion-failed": "ошибка преобразования геометрии",
  "unsupported-geometry": "неизвестный тип геометрии",
});

const OBJECT_MODE_LABELS = Object.freeze({
  all: "все",
  none: "не показывать",
  selected: "выделенные",
});

const OPTIONS_PANEL_ID = "geometry-viewer-options-panel";
const GEOMETRY_FIT_ALL_PADDING = 1 + 0.08 / 3;

const sourceScaleLabel = (scale) =>
  `×${scale.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`;

function diagnosticDetail(diagnostic) {
  if (typeof diagnostic === "string") return diagnostic;
  return diagnostic?.message ?? diagnostic?.code ?? String(diagnostic);
}

function diagnosticMessage(diagnostic) {
  const message = DIAGNOSTIC_REASONS[diagnostic?.code] ??
    diagnosticDetail(diagnostic);
  const recordIndex = Number(diagnostic?.recordIndex);
  const sourceLabel = diagnostic?.schemaId === "elements"
    ? "Элемент"
    : diagnostic?.schemaId === "regions"
      ? "Область"
      : "";

  return sourceLabel && Number.isInteger(recordIndex) && recordIndex >= 0
    ? `${sourceLabel} №${recordIndex + 1} — ${message}`
    : message;
}

function diagnosticLevel(diagnostic) {
  const value = diagnostic?.level ?? diagnostic?.severity ?? "warning";
  return String(value).toLowerCase();
}

export function ResultsGeometryViewport(props) {
  let viewerElement;
  let toolbarElement;
  let optionsPanelElement;
  let activePanelButton;
  let viewerResizeObserver;
  let renderModeBeforeSources = null;
  let sourceSettingsButton;
  let sourceSettingsBackButton;
  let timeAnimationFrame;
  let pendingTimeSelection;

  const [sceneModel, setSceneModel] = createSignal(null);
  const [sceneError, setSceneError] = createSignal("");
  const [viewportError, setViewportError] = createSignal("");
  const [viewRequest, setViewRequest] = createSignal(null);
  const [renderMode, setRenderMode] = createSignal("solid");
  const [orthographicView, setOrthographicView] = createSignal(true);
  const [showEdges, setShowEdges] = createSignal(true);
  const [showVertices, setShowVertices] = createSignal(false);
  const [showDiscretizationLines, setShowDiscretizationLines] =
    createSignal(false);
  const [showCentersAndNodes, setShowCentersAndNodes] = createSignal(false);
  const [showPrescribedSources, setShowPrescribedSources] = createSignal(false);
  const [prescribedSourceStyle, setPrescribedSourceStyle] = createSignal("thin");
  const [currentSourceScale, setCurrentSourceScale] = createSignal(1);
  const [magnetizationSourceScale, setMagnetizationSourceScale] = createSignal(1);
  const [elementsMode, setElementsMode] = createSignal("all");
  const [regionsMode, setRegionsMode] = createSignal("all");
  const [showLocalSymmetry, setShowLocalSymmetry] = createSignal(true);
  const [showAxialSymmetry, setShowAxialSymmetry] = createSignal(true);
  const [showPeriodicSymmetry, setShowPeriodicSymmetry] = createSignal(true);
  const [showMirrorSymmetry, setShowMirrorSymmetry] = createSignal(true);
  const [openPanel, setOpenPanel] = createSignal(null);
  const [panelPosition, setPanelPosition] = createSignal({ left: 8, top: 40 });
  const [renderStats, setRenderStats] = createSignal(EMPTY_RENDER_STATS);

  // Scope the index to the loaded task before any frame is projected, including
  // when another task is loaded while the floating window is closed.
  const timeState = createMemo(() => geometryTimeState(
    props.model?.general,
    props.timeIndex ?? 0,
  ));
  const timeFrame = createMemo(() => {
    const state = timeState();
    if (!props.open) return { ...state, model: props.model };
    return buildGeometryTimeModel(props.model, props.moves, state.index);
  });
  const displaySceneResult = createMemo(() => {
    if (!props.open) return { scene: null, error: "" };
    const model = timeFrame().model;
    if (model === props.model) return { scene: sceneModel(), error: "" };
    try {
      return { scene: buildGeometryScene(model), error: "" };
    } catch (error) {
      return {
        scene: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  // Equal scene references suppress surface rebuilds for amplitude-only time
  // changes when the geometry itself has no trajectory.
  const displayScene = createMemo(() => displaySceneResult().scene);
  const cancelTimeSelection = () => {};

  const filters = createMemo(() => ({
    objectModes: {
      elements: elementsMode(),
      regions: regionsMode(),
    },
    selections: {
      elements: new Set(props.selections?.elements ?? []),
      regions: new Set(props.selections?.regions ?? []),
    },
    symmetry: {
      axial: showAxialSymmetry(),
      local: showLocalSymmetry(),
      mirror: showMirrorSymmetry(),
      periodic: showPeriodicSymmetry(),
    },
  }));

  const sourceScene = createMemo(() => {
    if (!props.open || !showPrescribedSources() || !displayScene()) return null;
    try {
      const frame = timeFrame();
      const amplitude = sourceAmplitudeFactors(
        frame.model?.elements,
        props.amplitudes,
        frame.time,
      );
      const scene = buildSourceVectorScene(
        displayScene(),
        frame.model?.elements,
        props.prescribedSources,
        {
          limit: SOURCE_VECTOR_LIMIT,
          general: frame.model?.general,
          filters: filters(),
          amplitudeFactors: amplitude.factors,
          referenceScene: sceneModel(),
        },
      );
      return {
        ...scene,
        diagnostics: [...amplitude.diagnostics, ...scene.diagnostics],
      };
    } catch (error) {
      return {
        vectors: [],
        maximumMagnitude: { current: 0, magnetization: 0 },
        sceneDiagonal: 0,
        rowsTruncated: false,
        imagesTruncated: false,
        truncated: false,
        diagnostics: [{
          level: "warning",
          code: "source-vector-conversion-failed",
          message: "Не удалось подготовить векторы заданных источников: " +
            (error instanceof Error ? error.message : String(error)),
        }],
      };
    }
  });

  const changePrescribedSources = (checked) => {
    if (checked === showPrescribedSources()) return;
    if (checked) {
      renderModeBeforeSources = renderMode();
      setRenderMode("translucent");
    } else {
      if (renderModeBeforeSources !== null) {
        setRenderMode(renderModeBeforeSources);
      }
      renderModeBeforeSources = null;
    }
    setShowPrescribedSources(checked);
  };

  const counts = () => displayScene()?.counts ?? EMPTY_COUNTS;
  const diagnostics = () => [
    ...(timeFrame()?.diagnostics ?? []),
    ...(displayScene()?.diagnostics ?? []),
    ...(sourceScene()?.diagnostics ?? []),
  ];
  const budgetWarning = () => {
    const stats = renderStats();
    const messages = [];
    if (stats.truncated) {
      messages.push(
        `Показаны первые ${stats.renderedInstances} экземпляров из ` +
        `${stats.selectedInstances}. Измените режимы показа.`,
      );
    }
    if (stats.discretizationTruncated) {
      messages.push(
        "Часть линий дискретизации или точек скрыта из-за ограничения " +
        "объёма 3D-сцены.",
      );
    }
    if (sourceScene()?.rowsTruncated) {
      messages.push(
        `Показ заданных источников ограничен первыми ${SOURCE_VECTOR_LIMIT} ` +
        "строками таблицы.",
      );
    }
    if (sourceScene()?.imagesTruncated) {
      messages.push(
        "Показ заданных источников с учётом симметрии ограничен " +
        `${SOURCE_VECTOR_LIMIT} стрелками. Измените режимы показа.`,
      );
    }
    return messages.join(" ");
  };

  const updatePanelPosition = () => {
    if (!openPanel() || !viewerElement || !activePanelButton) return;

    const viewerBounds = viewerElement.getBoundingClientRect();
    const buttonBounds = activePanelButton.getBoundingClientRect();
    const toolbarBounds = toolbarElement?.getBoundingClientRect();
    const panelWidth = optionsPanelElement?.offsetWidth ?? 248;
    const maximumLeft = Math.max(8, viewerBounds.width - panelWidth - 8);
    setPanelPosition({
      left: Math.min(
        Math.max(buttonBounds.left - viewerBounds.left, 8),
        maximumLeft,
      ),
      top: Math.max(
        (toolbarBounds?.bottom ?? buttonBounds.bottom) - viewerBounds.top + 4,
        4,
      ),
    });
  };

  const setViewerElement = (element) => {
    viewerResizeObserver?.disconnect();
    viewerElement = element;
    if (!element || typeof ResizeObserver !== "function") return;

    viewerResizeObserver = new ResizeObserver(updatePanelPosition);
    viewerResizeObserver.observe(element);
  };

  const togglePanel = (name, event) => {
    if (openPanel() === name || (name === "general" && openPanel() === "sources")) {
      setOpenPanel(null);
      return;
    }

    activePanelButton = event.currentTarget;
    setOpenPanel(name);
    queueMicrotask(updatePanelPosition);
  };

  const openSourceSettings = () => {
    setOpenPanel("sources");
    queueMicrotask(() => {
      updatePanelPosition();
      sourceSettingsBackButton?.focus();
    });
  };

  const closeSourceSettings = () => {
    setOpenPanel("general");
    queueMicrotask(() => {
      updatePanelPosition();
      sourceSettingsButton?.focus();
    });
  };

  const closePanel = (restoreFocus = false) => {
    setOpenPanel(null);
    if (restoreFocus) activePanelButton?.focus();
  };

  const requestView = (command, restoreFocus = false) => {
    setViewRequest((previous) => ({
      command,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
    closePanel(restoreFocus);
  };

  const handleViewerKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (openPanel() === "sources") {
        closeSourceSettings();
        return;
      }
      closePanel(true);
      return;
    }

    if (!isGeometryCameraShortcutTarget(event.target)) return;
    const command = geometryCameraCommandFromKeyboardEvent(event);
    if (!command) return;
    event.preventDefault();
    requestView(command);
  };

  onCleanup(() => {
    viewerResizeObserver?.disconnect();
    cancelTimeSelection();
  });

  createEffect(() => {
    const open = props.open;
    if (!open) {
      setOpenPanel(null);
      setViewRequest(null);
      setSceneModel(null);
      setSceneError("");
      setViewportError("");
      setRenderStats(EMPTY_RENDER_STATS);
      return;
    }

    const model = props.model;
    setViewportError("");
    setRenderStats(EMPTY_RENDER_STATS);

    try {
      setSceneModel(buildGeometryScene(model));
      setSceneError("");
    } catch (error) {
      setSceneModel(null);
      setSceneError(error instanceof Error ? error.message : String(error));
    }
  });

  return (
      <section
        ref={setViewerElement}
        class="geometry-viewer-window"
        tabIndex="0"
        onPointerDown={(event) => {
          if (isGeometryCameraShortcutTarget(event.target)) {
            viewerElement?.focus({ preventScroll: true });
          }
        }}
        onKeyDown={handleViewerKeyDown}
      >
        <div
          ref={(element) => (toolbarElement = element)}
          class="geometry-viewer-toolbar"
          role="toolbar"
          aria-label="Управление 3D-окном"
          onScroll={updatePanelPosition}
        >
          <div class="geometry-viewer-toolbar-controls">
            <button
              type="button"
              class="geometry-viewer-menu-button"
              classList={{ active: openPanel() === "elements" }}
              aria-expanded={openPanel() === "elements"}
              aria-controls={OPTIONS_PANEL_ID}
              aria-haspopup="dialog"
              title={`Элементы: ${OBJECT_MODE_LABELS[elementsMode()]}`}
              onClick={(event) => togglePanel("elements", event)}
            >
              Элементы
            </button>

            <button
              type="button"
              class="geometry-viewer-menu-button"
              classList={{ active: openPanel() === "regions" }}
              aria-expanded={openPanel() === "regions"}
              aria-controls={OPTIONS_PANEL_ID}
              aria-haspopup="dialog"
              title={`Области: ${OBJECT_MODE_LABELS[regionsMode()]}`}
              onClick={(event) => togglePanel("regions", event)}
            >
              Области
            </button>

            <button
              type="button"
              class="geometry-viewer-menu-button"
              classList={{ active: openPanel() === "symmetry" }}
              aria-expanded={openPanel() === "symmetry"}
              aria-controls={OPTIONS_PANEL_ID}
              aria-haspopup="dialog"
              title="Настроить показ образов симметрии"
              onClick={(event) => togglePanel("symmetry", event)}
            >
              Симметрии
            </button>

            <button
              type="button"
              class="geometry-viewer-menu-button"
              classList={{ active: openPanel() === "general" || openPanel() === "sources" }}
              aria-label="Общие опции отображения"
              aria-expanded={openPanel() === "general" || openPanel() === "sources"}
              aria-controls={OPTIONS_PANEL_ID}
              aria-haspopup="dialog"
              title="Настроить общие опции отображения"
              onClick={(event) => togglePanel("general", event)}
            >
              Общие опции
            </button>

            <select
              class="geometry-viewer-select"
              value={renderMode()}
              aria-label="Режим представления"
              title="Режим представления геометрии"
              onChange={(event) => {
                renderModeBeforeSources = null;
                setRenderMode(event.currentTarget.value);
              }}
            >
              <option value="solid">Сплошной</option>
              <option value="translucent">Полупрозрачный</option>
              <option value="wireframe">Каркас</option>
            </select>

            <button
              type="button"
              class="geometry-viewer-menu-button"
              classList={{ active: openPanel() === "view" }}
              aria-expanded={openPanel() === "view"}
              aria-controls={OPTIONS_PANEL_ID}
              aria-haspopup="dialog"
              title="Вписать геометрию или выбрать направление взгляда"
              onClick={(event) => togglePanel("view", event)}
            >
              Показ
            </button>
          </div>
        </div>

        <Show when={openPanel()}>
          <div
            ref={(element) => {
              optionsPanelElement = element;
              queueMicrotask(updatePanelPosition);
            }}
            id={OPTIONS_PANEL_ID}
            class="geometry-viewer-options-panel"
            classList={{ "geometry-viewer-source-options": openPanel() === "sources" }}
            role="dialog"
            aria-modal="false"
            aria-label={openPanel() === "view"
              ? "Команды показа геометрии"
              : openPanel() === "general"
                ? "Общие опции отображения"
                : openPanel() === "sources"
                  ? "Настройка стрелок заданных источников"
                  : openPanel() === "symmetry"
                    ? "Показ симметрий"
                    : `Показ ${openPanel() === "elements" ? "элементов" : "областей"}`}
            tabIndex="-1"
            style={{
              left: `${panelPosition().left}px`,
              top: `${panelPosition().top}px`,
            }}
          >
            <Show when={openPanel() === "view"}>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите A"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.FIT_ALL,
                  true,
                )}
              >
                Показать все
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите X"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_X,
                  true,
                )}
              >
                вид по X
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите Ctrl-X"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_X,
                  true,
                )}
              >
                вид против X
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите Y"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Y,
                  true,
                )}
              >
                вид по Y
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите Ctrl-Y"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Y,
                  true,
                )}
              >
                вид против Y
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите Z"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Z,
                  true,
                )}
              >
                вид по Z
              </button>
              <button
                type="button"
                class="geometry-viewer-view-command"
                title="или нажмите Ctrl-Z"
                onClick={() => requestView(
                  GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Z,
                  true,
                )}
              >
                вид против Z
              </button>
            </Show>

            <Show when={openPanel() === "elements"}>
              <div class="geometry-viewer-options-title">Показ элементов</div>
              <label>
                <input
                  type="radio"
                  name="geometry-elements-mode"
                  checked={elementsMode() === "all"}
                  onChange={() => setElementsMode("all")}
                />
                Все элементы
              </label>
              <label>
                <input
                  type="radio"
                  name="geometry-elements-mode"
                  checked={elementsMode() === "selected"}
                  onChange={() => setElementsMode("selected")}
                />
                Выделенные в списке
              </label>
              <label>
                <input
                  type="radio"
                  name="geometry-elements-mode"
                  checked={elementsMode() === "none"}
                  onChange={() => setElementsMode("none")}
                />
                Не показывать
              </label>
            </Show>

            <Show when={openPanel() === "regions"}>
              <div class="geometry-viewer-options-title">Показ областей</div>
              <label>
                <input
                  type="radio"
                  name="geometry-regions-mode"
                  checked={regionsMode() === "all"}
                  onChange={() => setRegionsMode("all")}
                />
                Все области
              </label>
              <label>
                <input
                  type="radio"
                  name="geometry-regions-mode"
                  checked={regionsMode() === "selected"}
                  onChange={() => setRegionsMode("selected")}
                />
                Выделенные в списке
              </label>
              <label>
                <input
                  type="radio"
                  name="geometry-regions-mode"
                  checked={regionsMode() === "none"}
                  onChange={() => setRegionsMode("none")}
                />
                Не показывать
              </label>
            </Show>

            <Show when={openPanel() === "symmetry"}>
              <div class="geometry-viewer-options-title">Показ симметрий</div>
              <label>
                <input
                  type="checkbox"
                  checked={showLocalSymmetry()}
                  onChange={(event) =>
                    setShowLocalSymmetry(event.currentTarget.checked)}
                />
                Локальная
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showAxialSymmetry()}
                  onChange={(event) =>
                    setShowAxialSymmetry(event.currentTarget.checked)}
                />
                Азимутальная
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showPeriodicSymmetry()}
                  onChange={(event) =>
                    setShowPeriodicSymmetry(event.currentTarget.checked)}
                />
                Периодическая
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showMirrorSymmetry()}
                  onChange={(event) =>
                    setShowMirrorSymmetry(event.currentTarget.checked)}
                />
                Зеркальная
              </label>
            </Show>

            <Show when={openPanel() === "general"}>
              <div class="geometry-viewer-options-title">Общие опции</div>
              <label>
                <input
                  type="checkbox"
                  checked={orthographicView()}
                  onChange={(event) =>
                    setOrthographicView(event.currentTarget.checked)}
                />
                Ортогональный вид
              </label>
              <label
                classList={{ "is-disabled": renderMode() === "wireframe" }}
                title={renderMode() === "wireframe"
                  ? "Рёбра обязательны в режиме «Каркас»"
                  : undefined}
              >
                <input
                  type="checkbox"
                  checked={renderMode() === "wireframe" || showEdges()}
                  disabled={renderMode() === "wireframe"}
                  onChange={(event) => setShowEdges(event.currentTarget.checked)}
                />
                Рёбра
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showVertices()}
                  onChange={(event) =>
                    setShowVertices(event.currentTarget.checked)}
                />
                Вершины
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showDiscretizationLines()}
                  onChange={(event) =>
                    setShowDiscretizationLines(event.currentTarget.checked)}
                />
                Линии дискретизации
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showCentersAndNodes()}
                  onChange={(event) =>
                    setShowCentersAndNodes(event.currentTarget.checked)}
                />
                Центры и узлы
              </label>
              <div class="geometry-viewer-source-option">
                <label>
                  <input
                    type="checkbox"
                    checked={showPrescribedSources()}
                    onChange={(event) =>
                      changePrescribedSources(event.currentTarget.checked)}
                  />
                  Заданные источники
                </label>
                <button
                  ref={(element) => (sourceSettingsButton = element)}
                  type="button"
                  class="geometry-viewer-source-settings-button"
                  title="Настройка стрелок"
                  aria-label="Настройка стрелок заданных источников"
                  onClick={openSourceSettings}
                >
                  ⚙
                </button>
              </div>
            </Show>

            <Show when={openPanel() === "sources"}>
              <button
                ref={(element) => (sourceSettingsBackButton = element)}
                type="button"
                class="geometry-viewer-view-command"
                onClick={closeSourceSettings}
              >
                ← Общие опции
              </button>
              <div class="geometry-viewer-options-title">Стрелки заданных источников</div>
              <fieldset class="geometry-viewer-source-style">
                <legend>Вид стрелок</legend>
                <label>
                  <input
                    type="radio"
                    name="geometry-source-arrow-style"
                    checked={prescribedSourceStyle() === "thin"}
                    onChange={() => setPrescribedSourceStyle("thin")}
                  />
                  Тонкие
                </label>
                <label>
                  <input
                    type="radio"
                    name="geometry-source-arrow-style"
                    checked={prescribedSourceStyle() === "solid"}
                    onChange={() => setPrescribedSourceStyle("solid")}
                  />
                  Объёмные
                </label>
              </fieldset>
              <label class="geometry-viewer-source-scale is-current">
                <span class="geometry-viewer-source-scale-heading">
                  <span>Плотность тока</span>
                  <output>{sourceScaleLabel(currentSourceScale())}</output>
                </span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={Math.log10(currentSourceScale())}
                  aria-label="Масштаб длины стрелок плотности тока"
                  aria-valuetext={sourceScaleLabel(currentSourceScale())}
                  onInput={(event) =>
                    setCurrentSourceScale(10 ** event.currentTarget.valueAsNumber)}
                />
                <span class="geometry-viewer-source-scale-ticks" aria-hidden="true">
                  <span>×0,1</span><span>×1</span><span>×10</span>
                </span>
              </label>
              <label class="geometry-viewer-source-scale is-magnetization">
                <span class="geometry-viewer-source-scale-heading">
                  <span>Намагниченность</span>
                  <output>{sourceScaleLabel(magnetizationSourceScale())}</output>
                </span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={Math.log10(magnetizationSourceScale())}
                  aria-label="Масштаб длины стрелок намагниченности"
                  aria-valuetext={sourceScaleLabel(magnetizationSourceScale())}
                  onInput={(event) =>
                    setMagnetizationSourceScale(10 ** event.currentTarget.valueAsNumber)}
                />
                <span class="geometry-viewer-source-scale-ticks" aria-hidden="true">
                  <span>×0,1</span><span>×1</span><span>×10</span>
                </span>
              </label>
              <button
                type="button"
                class="geometry-viewer-view-command"
                onClick={() => {
                  setCurrentSourceScale(1);
                  setMagnetizationSourceScale(1);
                }}
              >
                Сбросить длины к ×1
              </button>
            </Show>
          </div>
        </Show>

        <div class="geometry-viewer-canvas-region">
          <ThreeGeometryViewport
            scene={displayScene()}
            resultVectorScene={props.resultVectorScene}
            resultVectorScale={props.resultVectorScale}
            resultVectorColor={props.resultVectorColor}
            filters={filters()}
            mode={renderMode()}
            showEdges={showEdges()}
            showVertices={showVertices()}
            showDiscretizationLines={showDiscretizationLines()}
            showCentersAndNodes={showCentersAndNodes()}
            showPrescribedSources={showPrescribedSources()}
            prescribedSourceScene={sourceScene()}
            prescribedSourceStyle={prescribedSourceStyle()}
            currentSourceScale={currentSourceScale()}
            magnetizationSourceScale={magnetizationSourceScale()}
            projection={orthographicView() ? "orthographic" : "perspective"}
            viewRequest={viewRequest()}
            fitAllPadding={GEOMETRY_FIT_ALL_PADDING}
            instanceBudget={GEOMETRY_INSTANCE_BUDGET}
            onRenderStats={setRenderStats}
            onError={setViewportError}
          />
          <Show when={budgetWarning()} keyed>
            {(warning) => (
              <div class="geometry-viewer-budget-warning" role="status">
                {warning}
              </div>
            )}
          </Show>
        </div>

        <Show when={sceneError() || displaySceneResult().error || viewportError()}>
          <div class="geometry-viewer-error" role="alert">
            {sceneError() || displaySceneResult().error || viewportError()}
          </div>
        </Show>

        <div class="geometry-viewer-summary" aria-live="polite">
          <span>Элементы: {counts().elements}</span>
          <span>Области: {counts().regions}</span>
          <span>Примитивы: {counts().primitives}</span>
          <span>
            Показано экземпляров: {renderStats().renderedInstances}
            {" / "}{counts().instances}
          </span>
          <Show when={counts().skipped > 0}>
            <span class="geometry-viewer-skipped">
              Пропущено: {counts().skipped}
            </span>
          </Show>
        </div>

        <Show when={diagnostics().length > 0}>
          <details class="geometry-viewer-diagnostics">
            <summary>Диагностика геометрии ({diagnostics().length})</summary>
            <ul>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <li
                    class={`is-${diagnosticLevel(diagnostic)}`}
                    title={diagnosticDetail(diagnostic)}
                  >
                    {diagnosticMessage(diagnostic)}
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
      </section>
  );
}
