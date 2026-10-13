import { cssColor, type CanarySequence } from '../shared/canary';
import { findCanary } from '../shared/detect-canary';
import type { RendererApi, ScreencastReport } from '../shared/ipc';
import { contentMayShow, type ProtectionLevel, type ProtectionState, type SelfTestRecord } from '../shared/protection';

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

const alertLine = el('p', { className: 'alert' });

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
  const LEVEL_TEXT: Record<ProtectionLevel, string> = {
    unsupported: 'Unsupported here',
    unprotected: 'Not protected',
    'request-failed': 'Request failed',
    requested: 'Requested (not confirmed)',
    'readback-confirmed': 'Compositor reports excluded (pixels not yet tested)',
    'selftest-passed': 'Self-test passed (tested paths only)',
    'selftest-failed': 'SELF-TEST FAILED — content was captured',
  };

  const pill = el('span', { className: 'pill' });
  const detail = el('p', { className: 'detail' });
  const history = el('ul', { className: 'history' });
  const gaps = el('ul', { className: 'gaps' });
  const sensitive = el(
    'div',
    { className: 'sensitive' },
    el('h2', { text: 'Protected content area' }),
    el('p', { text: 'The terminal and snippet library will live here (Phase 2). For now this stands in for anything you would not want on a shared screen.' }),
    el('pre', { text: '$ export API_TOKEN=example-not-a-real-secret\n$ ./deploy.sh --env staging' }),
  );
  const gate = el('div', { className: 'gate' }, el('p', { text: 'Content hidden until the compositor confirms this window is excluded from capture.' }));
  let override = false;
  gate.append(
    button('Show anyway', () => {
      override = true;
      void api.getState().then(render);
    }),
  );

  function render(s: ProtectionState): void {
    pill.textContent = LEVEL_TEXT[s.level];
    pill.dataset.level = s.level;
    detail.textContent = s.detail;
    if (s.level === 'selftest-failed') override = false;
    const show = contentMayShow(s.level) || override;
    sensitive.hidden = !show;
    gate.hidden = show;

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
      const canvas = el('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas unavailable');
      for (let i = 0; i < 5; i++) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
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

  document.body.append(
    el(
      'header',
      {},
      el('h1', { text: 'InviTerminal' }),
      pill,
    ),
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
    canary,
    gate,
    sensitive,
    el('h3', { text: 'Self-test history' }),
    history,
    el('h3', { text: 'Known gaps on this platform' }),
    gaps,
  );

  api.onState(render);
  void api.getState().then(render);
}
