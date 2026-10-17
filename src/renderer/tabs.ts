import type { RendererApi, ShellProfileInfo } from '../shared/ipc';
import { button, el } from './dom';
import { mountTerminal, type TerminalOptions, type TerminalView } from './terminal';
import { track } from './usage';

interface Tab {
  id: number;
  view: TerminalView;
  host: HTMLDivElement;
  label: HTMLSpanElement;
  tabEl: HTMLDivElement;
}

export interface TabsView {
  bar: HTMLElement;
  newTab(profileId?: string): void;
  closeActive(): void;
  next(): void;
  prev(): void;
  active(): TerminalView | null;
  setOptions(o: TerminalOptions): void;
  fit(): void;
  refreshProfiles(): Promise<void>;
}

/**
 * Tabs: one xterm + one shell each. Inactive tabs are display:none and keep
 * receiving output; they are re-fitted when shown. Closing the last tab opens
 * a fresh one, so there is always a shell.
 */
export function mountTabs(container: HTMLElement, api: RendererApi, opts: { inputAllowed(): boolean; onBlockedInput(): void; terminalOptions(): TerminalOptions }): TabsView {
  const tabs: Tab[] = [];
  let activeId = -1;
  let nextId = 1;

  const list = el('div', { className: 'tab-list' });
  const profileSelect = el('select', { className: 'tab-profile' });
  profileSelect.title = 'Shell for new tabs';
  const bar = el(
    'div',
    { className: 'tab-bar' },
    list,
    button('+', () => {
      track(api, 'terminal.newTab');
      newTab(profileSelect.value || undefined);
    }),
    profileSelect,
  );

  async function refreshProfiles(): Promise<void> {
    const profiles: ShellProfileInfo[] = await api.terminal.profiles();
    const current = profileSelect.value;
    profileSelect.replaceChildren(...profiles.map((p) => Object.assign(el('option', { text: p.isDefault ? `${p.label} (default)` : p.label }), { value: p.id })));
    profileSelect.value = profiles.some((p) => p.id === current) ? current : (profiles.find((p) => p.isDefault)?.id ?? '');
  }

  function activate(id: number): void {
    activeId = id;
    for (const t of tabs) {
      const on = t.id === id;
      t.host.hidden = !on;
      t.tabEl.classList.toggle('active', on);
    }
    const t = tabs.find((x) => x.id === id);
    if (t) {
      requestAnimationFrame(() => {
        t.view.fit();
        t.view.focus();
      });
    }
  }

  function newTab(profileId?: string): void {
    const id = nextId++;
    const host = el('div', { className: 'tab-host' });
    container.append(host);
    const label = el('span', { text: '…' });
    const close = el('span', { className: 'tab-close', text: '×' });
    const tabEl = el('div', { className: 'tab' }, label, close);
    tabEl.dataset.tabId = String(id);
    list.append(tabEl);
    const view = mountTerminal(host, api, {
      ...opts.terminalOptions(),
      ...(profileId ? { profileId } : {}),
      inputAllowed: opts.inputAllowed,
      onBlockedInput: opts.onBlockedInput,
      onSession: (s) => {
        label.textContent = s.label;
        tabEl.dataset.sessionId = s.sessionId;
      },
      onExit: () => tabEl.classList.add('exited'),
    });
    const tab: Tab = { id, view, host, label, tabEl };
    tabs.push(tab);
    tabEl.addEventListener('mousedown', (e) => {
      if (e.target === close) return;
      activate(id);
    });
    close.addEventListener('click', () => {
      track(api, 'terminal.closeTab');
      closeTab(id);
    });
    activate(id);
  }

  function closeTab(id: number): void {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    t!.view.dispose();
    t!.host.remove();
    t!.tabEl.remove();
    if (tabs.length === 0) newTab();
    else if (activeId === id) activate(tabs[Math.min(i, tabs.length - 1)]!.id);
  }

  function step(delta: number): void {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    activate(tabs[(i + delta + tabs.length) % tabs.length]!.id);
  }

  void refreshProfiles();
  newTab();

  return {
    bar,
    newTab,
    closeActive: () => closeTab(activeId),
    next: () => step(1),
    prev: () => step(-1),
    active: () => tabs.find((t) => t.id === activeId)?.view ?? null,
    setOptions: (o) => tabs.forEach((t) => t.view.setOptions(o)),
    fit: () => tabs.find((t) => t.id === activeId)?.view.fit(),
    refreshProfiles,
  };
}
