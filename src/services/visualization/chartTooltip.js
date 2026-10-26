let nextTooltipId = 0;

export function chartTooltipBounds(point, viewport, contentHeight = 220) {
  const margin = 8, gap = 12;
  const width = Math.max(0, Math.min(360, viewport.width - 2 * margin));
  const height = Math.max(0, Math.min(220, contentHeight, viewport.height - 2 * margin));
  const below = Math.max(0, viewport.height - margin - point.y - gap);
  const above = Math.max(0, point.y - gap - margin);
  const useBelow = below >= Math.min(80, height) || below >= above;
  const maxHeight = Math.min(height, useBelow ? below : above);
  return {
    left: Math.max(margin, Math.min(point.x + gap, viewport.width - margin - width)),
    top: useBelow ? point.y + gap : Math.max(margin, point.y - gap - maxHeight),
    width, maxHeight,
  };
}

// Chart.js still resolves the hovered datasets and runs the existing callbacks.
// Only its tooltip presentation is replaced with a scrollable HTML window.
export function createChartTooltip(canvas) {
  const document = canvas.ownerDocument, window = document.defaultView;
  let element, point, hovered = false, hideTimer, signature = "";
  const cancelHide = () => { window.clearTimeout(hideTimer); hideTimer = undefined; };
  const hide = (immediate = false) => {
    cancelHide();
    if (hovered && !immediate) return;
    const close = () => { if (element) element.hidden = true; };
    if (immediate) { hovered = false; close(); }
    else hideTimer = window.setTimeout(close, 180);
  };
  const place = () => {
    if (!element || element.hidden || !point || hovered) return;
    const box = chartTooltipBounds(point,
      { width: window.innerWidth, height: window.innerHeight }, element.scrollHeight + 2);
    Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`,
      width: `${box.width}px`, maxHeight: `${box.maxHeight}px` });
  };
  // Remember the pointer for the next hovered value. Keep the open window
  // still while the user crosses the gap to reach its scrollbar.
  const track = event => { point = { x: event.clientX, y: event.clientY }; };
  const leave = () => hide();
  const outside = event => { if (!element?.contains(event.target) && event.target !== canvas) hide(true); };
  const scroll = event => { if (!element?.contains(event.target)) hide(true); };
  const resize = () => hide(true);
  const wheel = event => {
    if (event.ctrlKey || event.defaultPrevented || !element || element.hidden
      || element.scrollHeight <= element.clientHeight || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight) || 16;
    const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? element.clientHeight : 1;
    cancelHide();
    element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
      element.scrollTop + event.deltaY * unit));
    // Keep the wheel inside the visible list even at either end. The pointer
    // may stay on the result point; it need not cross into the tooltip window.
    event.preventDefault(); event.stopPropagation();
  };
  canvas.addEventListener("pointermove", track);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("scroll", scroll, true);
  window.addEventListener("resize", resize);

  const line = (parent, text, className = "") => {
    const node = document.createElement("div");
    if (className) node.className = className;
    node.textContent = String(text); parent.append(node);
  };
  return {
    hide,
    render({ chart, tooltip }) {
      if (!tooltip.opacity || !tooltip.body?.length) { hide(); return; }
      cancelHide();
      if (!element) {
        element = document.createElement("div"); element.className = "chart-scroll-tooltip";
        element.id = `chart-tooltip-${++nextTooltipId}`;
        element.setAttribute("role", "tooltip"); element.tabIndex = 0;
        element.addEventListener("pointerenter", () => { hovered = true; cancelHide(); });
        element.addEventListener("pointerleave", () => { hovered = false; hide(true); });
        element.addEventListener("wheel", wheel, { passive: false });
        // Expanded plots are native modal dialogs in the browser's top layer.
        (canvas.closest("dialog") ?? document.body).append(element);
      }
      const content = JSON.stringify([tooltip.title, tooltip.beforeBody, tooltip.body,
        tooltip.afterBody, tooltip.footer, tooltip.labelColors]);
      if (content !== signature) {
        element.replaceChildren(); signature = content;
        for (const title of tooltip.title ?? []) line(element, title, "chart-tooltip-title");
        for (const text of tooltip.beforeBody ?? []) line(element, text);
        tooltip.body.forEach((body, index) => {
          const row = document.createElement("div"); row.className = "chart-tooltip-item";
          const swatch = document.createElement("span"); swatch.className = "chart-tooltip-swatch";
          const color = tooltip.labelColors?.[index];
          if (typeof color?.borderColor === "string") swatch.style.backgroundColor = color.borderColor;
          row.append(swatch);
          const text = document.createElement("div");
          for (const value of [...body.before, ...body.lines, ...body.after]) line(text, value);
          row.append(text); element.append(row);
        });
        for (const text of [...(tooltip.afterBody ?? []), ...(tooltip.footer ?? [])]) line(element, text);
        element.scrollTop = 0;
      }
      if (!point) {
        const box = canvas.getBoundingClientRect();
        point = { x: box.left + tooltip.caretX * box.width / chart.width,
          y: box.top + tooltip.caretY * box.height / chart.height };
      }
      element.hidden = false; place();
    },
    dispose() {
      cancelHide(); element?.remove();
      canvas.removeEventListener("pointermove", track);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    },
  };
}
