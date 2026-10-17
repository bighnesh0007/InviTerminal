import type { CompanionStatus } from '../shared/companion';
import type { RendererApi } from '../shared/ipc';
import { button, el } from './dom';
import { track } from './usage';

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
    badge.textContent = `📱 ${s.clients}`;
    badge.title = `Sharing to ${s.clients} ${s.clients === 1 ? 'phone' : 'phones'}${s.devices.length ? `: ${s.devices.join(', ')}` : ''}`;
    startBtn.hidden = s.running;
    stopBtn.hidden = !s.running;
    forgetBtn.hidden = !s.remembered;
    qrWrap.hidden = !s.running || !s.qrDataUrl;
    if (s.running && s.qrDataUrl) qrImg.src = s.qrDataUrl;
    if (s.running) {
      const subnet = s.host ? `${s.host.split('.').slice(0, 3).join('.')}.0/24` : '192.168.0.0/24';
      const ufw = `sudo ufw allow from ${subnet} to any port ${s.port} proto tcp`;
      const devices = s.devices.length ? s.devices.join(', ') : 'none yet';
      info.replaceChildren(
        el('p', { className: 'companion-devices', text: `Connected: ${devices}` }),
        el('p', { className: 'field-note', text: `Scan with your phone's camera on the same WiFi. Address: https://${s.host}:${s.port}` }),
        ...(s.mdnsUrl
          ? [
              el('p', { className: 'field-note', text: `Also reachable as ${s.mdnsUrl} — if your phone supports .local names and your firewall lets mDNS in:` }),
              el('p', { className: 'fp', text: `sudo ufw allow from ${subnet} to any port 5353 proto udp` }),
            ]
          : []),
        el('p', { className: 'field-note', text: s.remembered ? 'Pairing is remembered: a phone that scanned once reconnects by itself — no need to scan again. "Forget paired phones" revokes them all.' : 'Pairing is not remembered: phones must scan again each time you start sharing.' }),
        el('p', { className: 'field-note', text: `Your phone warns about the certificate once — confirm this fingerprint matches, then proceed:` }),
        el('p', { className: 'fp', text: s.fingerprint ?? '' }),
        el('p', { className: 'field-note', text: 'Shared: AI answers, terminal explanations, and the live transcript (if enabled in Settings). Nothing else.' }),
        el('p', { className: 'field-note', text: `Phone stuck on "loading"? Your firewall is likely blocking the port. Allow it once (same port every time):` }),
        el('p', { className: 'fp', text: ufw }),
      );
    } else {
      info.replaceChildren();
    }
  }

  const startBtn = button('Start sharing', async () => {
    track(api, 'companion.start');
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
  const forgetBtn = button('Forget paired phones', async () => {
    track(api, 'companion.forget');
    render(await api.companion.forget());
    say('Forgotten. Every phone must scan the new QR to pair again.');
  }, say);
  forgetBtn.title = 'Rotate the pairing token and certificate — disconnects and un-pairs every phone';
  forgetBtn.hidden = true;

  api.companion.onStatus(render);
  void api.companion.status().then(render);

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Share to phone' }), button('Close', () => close())),
    el('p', { className: 'field-note', text: 'An encrypted link on your WiFi that your phone pairs with by scanning a QR. The desktop pushes AI answers, explanations and (optionally) the live transcript. LAN-only, never the internet.' }),
    el('div', { className: 'lib-actions' }, startBtn, stopBtn, forgetBtn),
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
