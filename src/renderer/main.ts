import { cssColor, type CanarySequence } from '../shared/canary';
import { findCanary } from '../shared/detect-canary';
import type { RendererApi, ScreencastReport } from '../shared/ipc';
import { contentMayShow, type ProtectionLevel, type ProtectionState, type SelfTestRecord } from '../shared/protection';
import { button as makeButton, el } from './dom';
import { mountLibrary } from './library';
import { actionForEvent, canonicalChord, DEFAULT_KEYMAP, type AppAction, type Keymap } from '../shared/keymap';
import { DEFAULT_SETTINGS, type SettingsView } from '../shared/settings';
import { mountAiPanel } from './ai-panel';
import { mountAudioPanel } from './audio-panel';
import { mountPracticePanel } from './practice-panel';
import { mountSettings } from './settings';
import { mountTabs } from './tabs';

declare global {
  interface Window {
    inviterminal: RendererApi;
  }
}

const api = window.inviterminal;
const role = new URLSearchParams(location.search).get('role') === 'control' ? 'control' : 'main';

const alertLine = el('p', { className: 'alert' });
const button = (text: string, onClick: () => Promise<unknown> | void) => makeButton(text, onClick, (m) => (alertLine.textContent = `Error: ${m}`));

// ---- canary (both roles) ----------------------------------------------------

const canary = el('div', { className: 'canary' });
canary.hidden = true;

function showCanary(seq: CanarySequence | null): void {
  canary.replaceChildren();
  canary.hidden = seq === null;
  for (const c of seq ?? []) {
    const stripe = el('div', { className: 'stripe' });
    // CSSOM assignment, not a style attribute: the CSP forbids inline style attributes.
    stripe.style.background = cssColor(c);
    canary.append(stripe);
  }
  // Two frames: one to lay out, one to be sure it was presented.
  requestAnimationFrame(() => requestAnimationFrame(() => api.canaryPainted()));
}
api.onCanary(showCanary);

if (role === 'control') {
  document.title = 'control';
  document.body.classList.add('control');
  document.body.append(
    el('p', { className: 'control-label', text: 'Control window — deliberately NOT protected. It must appear in the capture for a self-test to count.' }),
    canary,
  );
} else {
  renderMain();
}

// ---- main window --------------------------------------------------------------

function renderMain(): void {
  document.body.classList.add('main');
  const LEVEL_TEXT: Record<ProtectionLevel, string> = {
    unsupported: 'Unsupported here',
    unprotected: 'Not protected',
    'request-failed': 'Request failed',
    requested: 'Requested (not confirmed)',
    'readback-confirmed': 'Excluded per compositor (pixels not tested)',
    'selftest-passed': 'Self-test passed (tested paths only)',
    'selftest-failed': 'SELF-TEST FAILED — content was captured',
  };

  const pill = el('span', { className: 'pill' });
  const detail = el('p', { className: 'detail' });
  const history = el('ul', { className: 'history' });
  const gaps = el('ul', { className: 'gaps' });

  // Tab hosts live here; the tab bar sits above it inside the same covered area.
  const termHost = el('div', { className: 'term-host' });
  const gate = el('div', { className: 'gate' }, el('p', { text: 'Terminal hidden until the compositor confirms this window is excluded from capture. Keystrokes are not sent to the shell meanwhile.' }));
  const termWrap = el('main', { className: 'term-wrap' }, termHost, gate, canary);

  const drawer = el('section', { className: 'drawer' });
  drawer.hidden = true;
  const drawerToggle = button('Protection ▾', () => {
    drawer.hidden = !drawer.hidden;
    drawerToggle.textContent = drawer.hidden ? 'Protection ▾' : 'Protection ▴';
  });

  let state: ProtectionState | null = null;
  let override = false;
  /**
   * Set just before the window is hidden. A re-shown window is a new,
   * unprotected compositor window, so the content stays covered until
   * protection has been re-applied *after* this moment.
   */
  let concealedAt: string | null = null;
  const stillConcealed = () => concealedAt !== null && !(state !== null && contentMayShow(state.level) && state.appliedAt !== null && state.appliedAt > concealedAt);
  const inputAllowed = () => override || (state !== null && contentMayShow(state.level) && !stillConcealed());

  let termOptions = { fontSize: DEFAULT_SETTINGS.terminal.fontSize, scrollback: DEFAULT_SETTINGS.terminal.scrollback };
  let keymap: Keymap = { ...DEFAULT_KEYMAP };

  const tabs = mountTabs(termHost, api, {
    inputAllowed,
    onBlockedInput: () => {
      gate.classList.remove('pulse');
      void gate.offsetWidth; // restart the animation
      gate.classList.add('pulse');
    },
    terminalOptions: () => termOptions,
  });
  termWrap.prepend(tabs.bar);

  const panelChanged = () => {
    const anyOpen = library.isOpen() || settingsPanel.isOpen() || aiPanel.isOpen() || audioPanel.isOpen() || practicePanel.isOpen();
    termWrap.classList.toggle('lib-open', anyOpen);
    requestAnimationFrame(() => {
      tabs.fit();
      // Closing the last panel hands the keyboard back to the terminal.
      if (!anyOpen) tabs.active()?.focus();
    });
  };
  const library = mountLibrary(api, {
    paste: (text) => {
      tabs.active()?.paste(text);
      tabs.active()?.focus();
    },
    onOpenChange: (open) => {
      if (open) settingsPanel.close();
      panelChanged();
    },
    inputAllowed,
  });
  const settingsPanel = mountSettings(api, {
    onOpenChange: (open) => {
      if (open && library.isOpen()) library.toggle();
      if (open) aiPanel.close();
      panelChanged();
    },
  });
  const aiPanel = mountAiPanel(api, {
    onOpenChange: (open) => {
      if (open && library.isOpen()) library.toggle();
      if (open) settingsPanel.close();
      panelChanged();
    },
  });
  const explainSelection = () =>
    aiPanel.request(() => {
      const v = tabs.active();
      return { selection: v?.getSelectionText() ?? '', viewport: v?.getViewportText() ?? '' };
    });
  const closeOthers = (keep: string) => {
    if (keep !== 'library' && library.isOpen()) library.toggle();
    if (keep !== 'settings') settingsPanel.close();
    if (keep !== 'ai') aiPanel.close();
    if (keep !== 'audio') audioPanel.close();
    if (keep !== 'practice') practicePanel.close();
  };
  const audioPanel = mountAudioPanel(api, {
    onOpenChange: (open) => {
      if (open) closeOthers('audio');
      panelChanged();
    },
  });
  const practicePanel = mountPracticePanel(api, {
    onOpenChange: (open) => {
      if (open) closeOthers('practice');
      panelChanged();
    },
  });
  termWrap.append(library.element, settingsPanel.element, aiPanel.element, audioPanel.element, practicePanel.element);

  gate.append(
    button('Show anyway', () => {
      override = true;
      if (state) render(state);
    }),
  );

  function render(s: ProtectionState): void {
    state = s;
    if (concealedAt !== null && !stillConcealed()) concealedAt = null;
    pill.textContent = LEVEL_TEXT[s.level];
    pill.dataset.level = s.level;
    detail.textContent = s.detail;
    if (s.level === 'selftest-failed') override = false;
    const show = inputAllowed();
    const wasHidden = !gate.hidden;
    gate.hidden = show;
    termHost.classList.toggle('concealed', !show);
    library.element.classList.toggle('concealed', !show);
    settingsPanel.element.classList.toggle('concealed', !show);
    aiPanel.element.classList.toggle('concealed', !show);
    audioPanel.element.classList.toggle('concealed', !show);
    practicePanel.element.classList.toggle('concealed', !show);
    tabs.bar.classList.toggle('concealed', !show);
    // Nothing behind the cover may keep keyboard focus (e.g. the snippet search box).
    if (!show && document.activeElement instanceof HTMLElement && termWrap.contains(document.activeElement)) document.activeElement.blur();
    if (show && wasHidden) tabs.active()?.focus();
    // Problems should not hide behind a collapsed drawer.
    if ((s.level === 'unsupported' || s.level === 'selftest-failed' || s.level === 'request-failed') && drawer.hidden) drawerToggle.click();

    gaps.replaceChildren(...s.knownGaps.map((g) => el('li', { text: g })));
    history.replaceChildren(
      ...s.selfTests.map((t: SelfTestRecord) => {
        const stale = s.appliedAt !== null && t.at < s.appliedAt;
        return el('li', { className: `v-${t.verdict}${stale ? ' stale' : ''}`, text: `${t.at.replace('T', ' ').slice(0, 19)}  ${t.path}  ${t.verdict.toUpperCase()}${stale ? ' (before last re-apply)' : ''} — ${t.reason} ${t.detail}` });
      }),
    );
  }

  async function screencastSelfTest(): Promise<void> {
    alertLine.textContent = 'Pick the screen that shows this window in the dialog that opens…';
    const { protectedSeq, controlSeq } = await api.prepareScreencastSelfTest();
    const report: ScreencastReport = { protectedFound: false, controlFound: false, width: 0, height: 0, frames: 0 };
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      const video = el('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      // The first frames from PipeWire can be blank or stale.
      await new Promise((r) => setTimeout(r, 1000));
      const c = el('canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas unavailable');
      for (let i = 0; i < 5; i++) {
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const frame = { data: img.data, width: img.width, height: img.height, order: 'rgba' as const };
        report.protectedFound ||= findCanary(frame, protectedSeq).found;
        report.controlFound ||= findCanary(frame, controlSeq).found;
        report.width = img.width;
        report.height = img.height;
        report.frames++;
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      report.error = (e as Error).message.slice(0, 500);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
    const rec = await api.reportScreencastSelfTest(report);
    alertLine.textContent = `Screen-share self-test: ${rec.verdict.toUpperCase()} — ${rec.reason}`;
  }

  drawer.append(
    detail,
    el(
      'div',
      { className: 'actions' },
      button('Apply protection', () => api.protect()),
      button('Remove protection', () => api.unprotect()),
      button('Re-check', () => api.recheck()),
      button('Self-test: screenshot (automatic)', async () => {
        alertLine.textContent = 'Running screenshot self-test…';
        const rec = await api.runScreenshotSelfTest();
        alertLine.textContent = `Screenshot self-test: ${rec.verdict.toUpperCase()} — ${rec.reason}`;
      }),
      button('Self-test: screen share (portal)', screencastSelfTest),
    ),
    alertLine,
    el('h3', { text: 'Self-test history' }),
    history,
    el('h3', { text: 'Known gaps on this platform' }),
    gaps,
  );

  const hideButton = button('Hide', () => api.visibility.panicHide());
  const libraryButton = button('Snippets', () => library.toggle());
  const explainButton = button('Explain', () => explainSelection());
  const micButton = button('Mic', () => audioPanel.toggle());
  const practiceButton = button('Practice', () => practicePanel.toggle());
  const settingsButton = button('Settings', () => settingsPanel.toggle());
  document.body.append(el('header', { className: 'bar' }, el('h1', { text: 'InviTerminal' }), pill, audioPanel.badge, el('span', { className: 'spacer' }), explainButton, micButton, practiceButton, libraryButton, settingsButton, hideButton, drawerToggle), drawer, termWrap);

  // Button tooltips show the current shortcuts.
  const showChords = () => {
    hideButton.title = `Hide now (${canonicalChord(keymap.panicHide)})`;
    libraryButton.title = `Snippet library (${canonicalChord(keymap.toggleLibrary)})`;
    settingsButton.title = `Settings (${canonicalChord(keymap.openSettings)})`;
  };
  const applySettings = (v: SettingsView) => {
    keymap = v.effective.shortcuts;
    termOptions = { fontSize: v.effective.terminal.fontSize, scrollback: v.effective.terminal.scrollback };
    tabs.setOptions(termOptions);
    void tabs.refreshProfiles();
    showChords();
  };
  api.settings.onChange(applySettings);
  void api.settings.get().then(applySettings);

  // The drawer changes the terminal's height.
  new ResizeObserver(() => tabs.fit()).observe(drawer);

  api.visibility.onConceal(({ token, at }) => {
    concealedAt = at;
    // An override covered the window as it was; a re-shown window has to earn it again.
    override = false;
    if (state) render(state);
    requestAnimationFrame(() => requestAnimationFrame(() => api.visibility.concealed(token)));
  });

  const actions: Record<AppAction, () => void> = {
    panicHide: () => api.visibility.panicHide(),
    toggleLibrary: () => library.toggle(),
    openSettings: () => settingsPanel.toggle(),
    explainSelection: () => explainSelection(),
    newTab: () => tabs.newTab(),
    closeTab: () => tabs.closeActive(),
    nextTab: () => tabs.next(),
    prevTab: () => tabs.prev(),
  };
  // App shortcuts are taken in the capture phase, before xterm.js sees the key, so they never reach the shell.
  window.addEventListener(
    'keydown',
    (e) => {
      // The settings panel's shortcut fields record keys; they must not trigger actions.
      if (e.target instanceof HTMLElement && e.target.classList.contains('chord-input')) return;
      const action = actionForEvent(keymap, e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      actions[action]();
    },
    { capture: true },
  );

  api.onState(render);
  void api.getState().then(render);
}
