import { createEffect, createSignal, onCleanup } from "solid-js";
import aboutIconUrl from "../assets/zaica.BMP?url";
import packageMetadata from "../../package.json";
import "./AboutDialog.css";

// About panel and icon follow web-gui's TaskInfoBar.
export function AboutDialog() {
  const [aboutOpen, setAboutOpen] = createSignal(false);
  let aboutDialog, aboutButton, aboutCloseButton;

  createEffect(() => {
    if (!aboutDialog) return;
    if (aboutOpen()) {
      if (!aboutDialog.open) {
        aboutDialog.showModal();
        aboutCloseButton?.focus();
      }
    } else if (aboutDialog.open) {
      aboutDialog.close();
    }
  });

  onCleanup(() => {
    if (aboutDialog?.open) aboutDialog.close();
  });

  return <>
    <button
      ref={(el) => (aboutButton = el)}
      class="about-button"
      onClick={() => setAboutOpen(true)}
      title="О программе"
      aria-label="О программе"
      aria-haspopup="dialog"
    >
      <img
        class="about-button-image"
        src={aboutIconUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    </button>
    <dialog
      class="about-dialog"
      ref={(el) => (aboutDialog = el)}
      aria-labelledby="about-dialog-title"
      onClose={() => {
        setAboutOpen(false);
        aboutButton?.focus();
      }}
    >
      <h2 id="about-dialog-title" class="about-title">О программе E3D Viewer</h2>
      <p class="about-description">
        <span>Программа предназначена для просмотра</span>
        <span>результатов расчётных задач Clark,</span>
        <span>включая источники и поля в 3D,</span>
        <span>рабочие точки материалов, графики</span>
        <span>и цветовые карты по расчётным узлам.</span>
      </p>
      <div class="about-separator" aria-hidden="true" />
      <div class="about-version">Версия: {packageMetadata.version}</div>
      <div class="about-credits">
        <div>Разработчик: ChatGPT 5.6 Sol</div>
        <div class="about-curator-stack">
          <div>Куратор: Кулаев Ю.</div>
          <div>2026 г.</div>
          <button
            ref={(el) => (aboutCloseButton = el)}
            class="about-close-button"
            onClick={() => setAboutOpen(false)}
          >
            Закрыть
          </button>
        </div>
      </div>
    </dialog>
  </>;
}
