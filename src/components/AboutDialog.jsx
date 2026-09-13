import { createEffect, createSignal, onCleanup } from "solid-js";
import aboutIconUrl from "../assets/zaica.BMP?url";
import packageMetadata from "../../package.json";
import "./AboutDialog.css";

// About panel, icon and administrator access follow web-gui's TaskInfoBar.
export function AboutDialog(props) {
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [adminPassword, setAdminPassword] = createSignal("");
  const [adminError, setAdminError] = createSignal("");
  let aboutDialog, aboutButton, aboutCloseButton, adminDialog, adminPasswordInput;

  function resetAdminDialog() {
    setAdminPassword("");
    setAdminError("");
  }

  function openAdminDialog() {
    if (props.admin) return;

    resetAdminDialog();
    setAboutOpen(false);
    if (aboutDialog?.open) aboutDialog.close();
    queueMicrotask(() => {
      if (!adminDialog.open) adminDialog.showModal();
      adminPasswordInput?.focus();
    });
  }

  function handleAdminSubmit(event) {
    event.preventDefault();
    if (props.onAdminUnlock?.(adminPassword()) === true) {
      adminDialog.close();
      return;
    }

    setAdminError("Неверный пароль.");
    setAdminPassword("");
    queueMicrotask(() => adminPasswordInput?.focus());
  }

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
    if (adminDialog?.open) adminDialog.close();
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
          <button
            type="button"
            class="about-admin-button"
            disabled={props.admin}
            aria-pressed={props.admin}
            title={
              "Админ имеет право открывать задания в произвольном "
              + "каталоге проектов, а не только в clark.projects"
            }
            onClick={openAdminDialog}
          >
            Админ
          </button>
        </div>
      </div>
    </dialog>

    <dialog
      class="admin-dialog"
      ref={(el) => (adminDialog = el)}
      aria-labelledby="admin-dialog-title"
      onClose={() => {
        resetAdminDialog();
        aboutButton?.focus();
      }}
    >
      <form class="admin-form" onSubmit={handleAdminSubmit}>
        <h2 id="admin-dialog-title">Режим администратора</h2>
        <label for="admin-password">Пароль</label>
        <input
          ref={(el) => (adminPasswordInput = el)}
          id="admin-password"
          type="password"
          autocomplete="off"
          value={adminPassword()}
          onInput={(event) => {
            setAdminPassword(event.currentTarget.value);
            if (adminError()) setAdminError("");
          }}
        />
        <div class="admin-error" aria-live="polite">
          {adminError()}
        </div>
        <div class="admin-actions">
          <button type="submit">Включить</button>
          <button type="button" onClick={() => adminDialog.close()}>
            Отмена
          </button>
        </div>
      </form>
    </dialog>
  </>;
}
