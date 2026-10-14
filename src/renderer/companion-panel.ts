import type { CompanionStatus } from '../shared/companion';
import type { RendererApi } from '../shared/ipc';
import { button, el } from './dom';

export interface CompanionPanelView {
  element: HTMLElement;
  /** Always-visible header badge while sharing. */
  badge: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
}

/**
 * "Share to phone" panel. Scanning the QR pairs a phone browser on the same
 * WiFi over TLS; the desktop then pushes explanations to it. Sharing is off by
 * default and deliberately visible (badge + tray) while on. Behind the gate,
 * so the QR (which carries the pairing token) is not exposed on a shared screen.
 */
export function mountCompanionPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): CompanionPanelView {
  const panel = el('aside', { className: 'library companion-panel' });
  panel.hidden = true;

  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);
  const qrImg = el('img', { className: 'qr' });
  qrImg.alt = 'Pairing QR code';
  const qrWrap = el('div', { className: 'qr-wrap' }, qrImg);
  qrWrap.hidden = true;
  const info = el('div', { className: 'companion-info' });
  const badge = el('span', { className: 'rec-badge share-badge' });
  badge.hidden = true;

  let running = false;

  function render(s: CompanionStatus): void {
    running = s.running;
    badge.hidden = !s.running;
    badge.textContent = `📱 Sharing · ${s.clients} ${s.clients === 1 ? 'device' : 'devices'}`;
    startBtn.hidden = s.running;
    stopBtn.hidden = !s.running;
    qrWrap.hidden = !s.running || !s.qrDataUrl;
    if (s.running && s.qrDataUrl) qrImg.src = s.qrDataUrl;
    if (s.running) {
      const subnet = s.host ? `${s.host.split('.').slice(0, 3).join('.')}.0/24` : '192.168.0.0/24';
      const ufw = `sudo ufw allow from ${subnet} to any port ${s.port} proto tcp`;
      info.replaceChildren(
        el('p', { className: 'field-note', text: `Scan with your phone's camera on the same WiFi. Address: https://${s.host}:${s.port}` }),
        el('p', { className: 'field-note', text: `Your phone will warn about the certificate — confirm this fingerprint matches, then proceed:` }),
        el('p', { className: 'fp', text: s.fingerprint ?? '' }),
        el('p', { className: 'field-note', text: `${s.clients} phone(s) paired. Explanations you run will appear there. Nothing else is shared.` }),
        el('p', { className: 'field-note', text: `Phone stuck on "loading"? Your firewall is likely blocking the port. Allow it once (same port every time):` }),
        el('p', { className: 'fp', text: ufw }),
      );
    } else {
      info.replaceChildren();
    }
  }

  const startBtn = button('Start sharing', async () => {
    say('Starting the local server…');
    try {
      render(await api.companion.start());
      say('Sharing. Scan the QR with your phone (same WiFi).');
    } catch (e) {
      say((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }, say);
  const stopBtn = button('Stop sharing', async () => {
    await api.companion.stop();
    say('Stopped. The server is off.');
  }, say);
  stopBtn.hidden = true;

  api.companion.onStatus(render);
  void api.companion.status().then(render);

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Share to phone' }), button('Close', () => close())),
    el('p', { className: 'field-note', text: 'Opens a one-time, encrypted link on your LAN that your phone browser can pair with by scanning a QR. The desktop pushes terminal explanations to the phone. Off by default; LAN-only; never the internet.' }),
    el('div', { className: 'lib-actions' }, startBtn, stopBtn),
    qrWrap,
    info,
    message,
  );

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    opts.onOpenChange(false);
  }

  return {
    element: panel,
    badge,
    isOpen: () => !panel.hidden,
    toggle() {
      panel.hidden = !panel.hidden;
      opts.onOpenChange(!panel.hidden);
    },
    close,
  };
}
