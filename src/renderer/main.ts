import { cssColor, type CanarySequence } from '../shared/canary';
import { findCanary } from '../shared/detect-canary';
import type { RendererApi, ScreencastReport } from '../shared/ipc';
import { contentMayShow, type ProtectionLevel, type ProtectionState, type SelfTestRecord } from '../shared/protection';
import { mountTerminal } from './terminal';

declare global {
  interface Window {
    inviterminal: RendererApi;
  }
}

const api = window.inviterminal;
const role = new URLSearchParams(location.search).get('role') === 'control' ? 'control' : 'main';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

const alertLine = el('p', { className: 'alert' });

function button(text: string, onClick: () => Promise<unknown> | void): HTMLButtonElement {
  const b = el('button', { text });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      alertLine.textContent = `Error: ${(e as Error).message}`;
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

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

  const view = mountTerminal(termHost, api, inputAllowed, () => {
    gate.classList.remove('pulse');
    void gate.offsetWidth; // restart the animation
    gate.classList.add('pulse');
  });

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
    if (show && wasHidden) view.focus();
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

  const hideButton = button('Hide (Ctrl+Shift+H)', () => api.visibility.panicHide());
  document.body.append(el('header', { className: 'bar' }, el('h1', { text: 'InviTerminal' }), pill, el('span', { className: 'spacer' }), hideButton, drawerToggle), drawer, termWrap);

  // The drawer changes the terminal's height.
  new ResizeObserver(() => view.fit()).observe(drawer);

  api.visibility.onConceal(({ token, at }) => {
    concealedAt = at;
    // An override covered the window as it was; a re-shown window has to earn it again.
    override = false;
    if (state) render(state);
    requestAnimationFrame(() => requestAnimationFrame(() => api.visibility.concealed(token)));
  });

  // Ctrl+Shift+H hides immediately, whether focus is in the terminal or elsewhere.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyH') {
        e.preventDefault();
        e.stopPropagation();
        api.visibility.panicHide();
      }
    },
    { capture: true },
  );

  api.onState(render);
  void api.getState().then(render);
}
