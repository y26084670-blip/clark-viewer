export const MIN_VIEWPORT_WIDTH = 1100;
export const MIN_VIEWPORT_HEIGHT = 800;

export function isViewportUsable(width, height) {
  return width >= MIN_VIEWPORT_WIDTH && height >= MIN_VIEWPORT_HEIGHT;
}

/** Gate the entrypoint without unmounting an application that is already running. */
export function installViewportGate({ root, applicationName, load }) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const gate = document.createElement("dialog");
  gate.className = "viewport-gate";
  gate.setAttribute("aria-labelledby", "viewport-gate-title");
  const card = document.createElement("div");
  card.className = "viewport-gate-card";
  const title = document.createElement("h1");
  title.id = "viewport-gate-title";
  const message = document.createElement("p");
  const dimensions = document.createElement("p");
  dimensions.className = "viewport-gate-dimensions";
  card.append(title, message, dimensions);
  gate.append(card);
  document.body.append(gate);

  const originalInert = root.inert;
  const originalAriaHidden = root.getAttribute("aria-hidden");
  let previousFocus;
  let blocked = false;
  let loading = false;
  let mountApp;
  let mounted = false;
  let disposeApp;
  let disposed = false;
  let failed = false;

  function restoreRoot() {
    root.inert = originalInert;
    if (originalAriaHidden === null) root.removeAttribute("aria-hidden");
    else root.setAttribute("aria-hidden", originalAriaHidden);
  }

  function showFailure(error) {
    if (disposed) return;
    failed = true;
    console.error("Application startup failed:", error);
    update();
  }

  function update() {
    if (disposed) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const mustBlock = failed || !isViewportUsable(width, height);
    if (mustBlock) {
      title.textContent = failed ? "Не удалось загрузить приложение" : "Работа приложения заблокирована";
      message.textContent = failed
        ? "Обновите страницу, чтобы повторить загрузку."
        : `${applicationName} требует окно не меньше ${MIN_VIEWPORT_WIDTH} × ${MIN_VIEWPORT_HEIGHT} пикселей. Увеличьте окно или используйте устройство с большим экраном. При достаточном размере блокировка снимется автоматически.`;
      dimensions.textContent = failed ? "" : "Текущая область окна: " + width + " × " + height + ".";
      if (!blocked) {
        previousFocus = document.activeElement;
        blocked = true;
        root.inert = true;
        root.setAttribute("aria-hidden", "true");
      }
      if (!gate.open) gate.showModal();
      return;
    }

    if (blocked) {
      blocked = false;
      restoreRoot();
      gate.close();
      previousFocus?.focus?.({ preventScroll: true });
    }
    if (!loading) {
      loading = true;
      try {
        // Loading starts once; mounting waits if the window shrinks during import.
        Promise.resolve(load()).then((mount) => {
          if (disposed) return;
          mountApp = mount;
          update();
        }).catch(showFailure);
      } catch (error) {
        showFailure(error);
      }
    } else if (mountApp && !mounted) {
      mounted = true;
      try {
        disposeApp = mountApp();
        update();
      } catch (error) {
        showFailure(error);
      }
    }
  }

  const preventCancel = (event) => event.preventDefault();
  gate.addEventListener("cancel", preventCancel);

  // App-level keyboard/drag handlers must not operate behind the modal gate.
  const stopInteraction = (event) => {
    if (blocked) event.stopImmediatePropagation();
  };
  const inputEvents = ["keydown", "keyup", "pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "touchstart", "touchmove", "touchend", "click", "dblclick", "wheel"];
  for (const name of inputEvents) window.addEventListener(name, stopInteraction, true);
  window.addEventListener("resize", update);

  // Keep the gate above app dialogs that finish opening asynchronously.
  const observer = new window.MutationObserver((records) => {
    if (blocked && gate.open && records.some(({ target }) => target.tagName === "DIALOG" && target.open)) {
      gate.close();
      gate.showModal();
    }
  });
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["open"] });
  update();

  return () => {
    disposed = true;
    window.removeEventListener("resize", update);
    for (const name of inputEvents) window.removeEventListener(name, stopInteraction, true);
    observer.disconnect();
    gate.removeEventListener("cancel", preventCancel);
    restoreRoot();
    if (gate.open) gate.close();
    gate.remove();
    disposeApp?.();
  };
}
