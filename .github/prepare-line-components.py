from pathlib import Path
import json


def replace(path, before, after):
    p = Path(path)
    source = p.read_text(encoding='utf-8')
    if source.count(before) != 1:
        raise RuntimeError(f'{path}: expected one exact anchor, found {source.count(before)}')
    p.write_text(source.replace(before, after), encoding='utf-8')

replace('src/services/results/resultRequests.js',
    'import { lineSeries, regionSurfaceGrid } from "./resultPlots.js";',
    'import { regionSurfaceGrid } from "./resultPlots.js";\nimport { lineComponentSeries, normalizeFieldLineComponents } from "./fieldLineComponents.js";')
replace('src/services/results/resultRequests.js',
    'export async function readLineFrame(request) {\n  const quantity = QUANTITIES[request.quantityKey];',
    'export async function readLineFrame(request) {\n  const components = normalizeFieldLineComponents(request.components ?? [request.component ?? "norm"]);\n  if (!components.length) return { series: [], skipped: [] };')
replace('src/services/results/resultRequests.js',
    'frames.flatMap(({ frame, record }) => lineSeries(frame, record, quantity,\n      request.component, request.direction, { unfold: true }))',
    'frames.flatMap(({ frame, record }) => lineComponentSeries(frame, record, request.quantityKey,\n      components, request.direction, { unfold: true }))')
replace('src/services/results/resultRequests.js',
    'return lineSeries(frame, object.record, quantity, request.component, request.direction, { copy: request.copy });',
    'return lineComponentSeries(frame, object.record, request.quantityKey, components, request.direction, { copy: request.copy });')
replace('src/services/results/resultFrameController.js',
    '  // Plot choices belong to the frame context; time alone may reuse the old frame.',
    '''  // Component arrays are sets; an empty set is distinct from the legacy default.
  if (a.components !== undefined || b.components !== undefined) {
    if (!Array.isArray(a.components) || !Array.isArray(b.components)) return false;
    const left = [...new Set(a.components.map(String))].sort();
    const right = [...new Set(b.components.map(String))].sort();
    if (left.length !== right.length || left.some((value, i) => value !== right[i])) return false;
  }
  // Plot choices belong to the frame context; time alone may reuse the old frame.''')
replace('src/components/LineChart.jsx',
    '  function applyChartLimits(range) {\n    if (!chart) return;\n    range = movieState?.range ?? range;',
    '''  // Optional full-cycle bounds are supplied only by FieldLines. Manual scales
  // win; during GIF recording the exact automatic policy is captured once.
  function automaticYRange() {
    const bounds = props.autoYRange;
    return bounds && Number.isFinite(bounds.minimum) && Number.isFinite(bounds.maximum)
      && bounds.minimum < bounds.maximum ? { yMin: bounds.minimum, yMax: bounds.maximum } : {};
  }
  function applyChartLimits(range) {
    if (!chart) return;
    range = movieState?.range ?? (props.autoScaleToggle && untrack(autoScale)
      ? { ...range, ...automaticYRange() } : range);''')
replace('src/components/LineChart.jsx',
    'movieState = { range: automatic ? {} : range, width: canvas.width, height: canvas.height,',
    'movieState = { range: automatic ? automaticYRange() : range, width: canvas.width, height: canvas.height,')

for name in ['package.json', 'package-lock.json']:
    p = Path(name); value = json.loads(p.read_text(encoding='utf-8'))
    assert value['version'] == '4.18.0', name
    value['version'] = '4.19.0'
    if name == 'package-lock.json':
        assert value['packages']['']['version'] == '4.18.0'
        value['packages']['']['version'] = '4.19.0'
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

replace('docs/AI_CHART_RENDERING.md',
    'Обновлено: 2026-10-03 23:39 UTC+3.',
    '''Обновлено: 2026-10-07. Версия 4.19.0.

## Поле на линиях: компоненты и глобальные пределы (4.19.0)

Только FieldLines использует кнопку «Компоненты» с независимыми флажками
Модуль, X, Y, Z. Начальный набор — Модуль. Пустой набор допустим: график пуст,
есть подсказка «Выберите компоненты поля», HDF5 не читается, GIF не запускается.
Набор сохраняется при смене времени и величины. Модуль вычисляется по всем трём
сохранённым компонентам, компоненты сохраняют знак. Все выбранные серии одного
объекта формируются из одного чтения кадра/LS. Подписи и подсказки содержат |B|,
Bx/By/Bz или |A|, Ax/Ay/Az и исходные XYZ. Одиночный интерфейс component оставлен
совместимым; FieldAreas и QuantitySelect не изменены.

FieldComponentsMenu размещён в Portal, не обрезается панелью графика. Переключение
флажка не закрывает список; кнопка, внешний щелчок, уход фокуса и Escape закрывают.
ArrowUp/Down и Home/End перемещают фокус, Space меняет флажок. Во время GIF меню
закрыто и заблокировано, в том числе вне inert-поддерева.

Флажок «За весь расчёт» по умолчанию запрошен и доступен при корректной полной
HEADER/RANGES. fieldLineCycleRange использует resultCycleRange из коммита
487359b: объединяет ТОЛЬКО выбранные каналы и исходные ID площадок. Пределы
покрывают все узлы и локальные образы этих площадок, поэтому могут быть шире
текущего среза. Порядок IDs и временная сетка проверяются по текущей модели.
Диапазоны уже в единицах отображения; повторное mu0-преобразование A/B запрещено.
Partial/stale/отсутствующие/повреждённые сводки не блокируют просмотр: общий режим
недоступен, строка состояния объясняет переход к текущему кадру. Скалярная сводка
не заменяется нормой компонент и не собирается дополнительным проходом всех шагов.

LineChart принимает необязательный autoYRange: объединённый диапазон с фиксированным
5% запасом, в том числе для константы и нуля. Он применяется ТОЛЬКО при включённом
«Авто». Выключенный «Авто», рамка и панорамирование сохраняют ручные пределы;
флажки компонент и времени не навязывают сброс. В GIF автоматический глобальный
диапазон фиксируется при подготовке; ручной масштаб также сохраняется. Без
autoYRange другие вкладки ведут себя как прежде. Глобальные шкалы 3D и областей
не подключены этой правкой. Solver и исходный контракт HEADER/RANGES не изменены.

Проверки: test/fieldLineComponents.test.js, scripts/check-field-line-components.mjs,
фактическое свидетельство: verification/field-line-components.json.
''')
replace('docs/AI_CHART_RENDERING.md',
    'бюджет выборки, компонента, направление, номер локального образа и режим всех',
    'бюджет выборки, набор компонент линий, направление, номер локального образа и режим всех')
replace('docs/AI_RESULT_RANGES.md',
    '**UI-переключатель общего масштаба и его применение к 3D/поверхностям/GIF ещё не\nподключены. Текущая отрисовка после этой правки не меняет нормировку автоматически.**',
    '''**В 4.19.0 общий диапазон подключён только к «Поле на линиях», включая GIF этой
вкладки: флажок «За весь расчёт» применяет объединённые пределы выбранных компонент
при включённом «Авто». Ручной масштаб сохраняется. Для 3D и «Поле в областях»
подключение глобальных шкал по-прежнему остаётся отдельной задачей.**

Владелец интеграции линий: fieldLineComponents.js и FieldLines.jsx; правила,
проверки и совместимость: [AI_CHART_RENDERING.md](AI_CHART_RENDERING.md).
Коммит 487359b сохранён, читатель resultRanges.js и Hdf5ResultFile не изменены.''')
replace('README.md', '# E3D Viewer\n', '''# E3D Viewer

## 4.19.0 — компоненты поля на линиях

Во вкладке «Поле на линиях» кнопка «Компоненты» даёт независимый выбор Модуля,
X, Y, Z и одновременные кривые. Начально выбран модуль, пустой набор допустим.
Флажок «За весь расчёт» использует полные глобальные диапазоны HEADER/RANGES
для отмеченных компонент выбранных площадок. При отсутствии подходящей сводки
показана причина, просмотр работает с пределами текущего кадра. Общие пределы
применяются при включённом «Авто» и сохраняются в GIF; ручной масштаб не сбрасывается.
«Поле в областях» остаётся с одиночным выбором. Solver, 3D-симметрии и форматы HDF5
не изменены. Основа глобальных диапазонов 487359b сохранена.
[Контракт](docs/AI_CHART_RENDERING.md) · [Проверки](docs/verification/field-line-components.json).
''')
print('Applied exact-anchor integration; global HDF5 reader and FieldAreas left unchanged.')
