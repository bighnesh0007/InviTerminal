import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliAction } from '../src/main/visibility/cli';
import { VisibilityController, type WindowLike } from '../src/main/visibility/VisibilityController';

function fakeWindow(visible = true) {
  const events: string[] = [];
  const w: WindowLike & { events: string[]; destroyed: boolean; visible: boolean } = {
    events,
    destroyed: false,
    visible,
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    show: () => {
      events.push('show');
      w.visible = true;
    },
    hide: () => {
      events.push('hide');
      w.visible = false;
    },
    focus: () => events.push('focus'),
  };
  return w;
}

const OPTS = { concealTimeoutMs: 300, panicConcealTimeoutMs: 80 };

afterEach(() => vi.useRealTimers());

describe('parseCliAction', () => {
  it('recognises exact flags among Chromium switches and the app path', () => {
    expect(parseCliAction(['/usr/lib/electron/electron', '--no-sandbox', '/app', '--toggle'])).toBe('toggle');
    expect(parseCliAction(['x', '--hide'])).toBe('hide');
    expect(parseCliAction(['x', '--show'])).toBe('show');
  });

  it('ignores anything that is not an exact flag', () => {
    expect(parseCliAction(['x', '--toggle=1', '--TOGGLE', 'toggle', '--toggles'])).toBeNull();
    expect(parseCliAction([])).toBeNull();
  });
});

describe('VisibilityController', () => {
  it('conceals the content before hiding the window', async () => {
    const w = fakeWindow();
    const c = new VisibilityController(w, async () => void w.events.push('conceal'), OPTS);
    const r = await c.hide('toggle');
    expect(w.events).toEqual(['conceal', 'hide']);
    expect(r.concealed).toBe(true);
  });

  it('hides anyway when the renderer never confirms — hiding is the safe direction', async () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    const c = new VisibilityController(w, () => new Promise<void>(() => {}), OPTS);
    const p = c.hide('toggle');
    await vi.advanceTimersByTimeAsync(299);
    expect(w.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect((await p).concealed).toBe(false);
    expect(w.events).toEqual(['hide']);
  });

  it('panic hide waits for the cover for less time', async () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    const c = new VisibilityController(w, () => new Promise<void>(() => {}), OPTS);
    const p = c.hide('panic');
    await vi.advanceTimersByTimeAsync(81);
    await p;
    expect(w.events).toEqual(['hide']);
  });

  it('hides when concealing throws', async () => {
    const w = fakeWindow();
    const c = new VisibilityController(w, async () => Promise.reject(new Error('renderer gone')), OPTS);
    expect((await c.hide('cli')).concealed).toBe(false);
    expect(w.visible).toBe(false);
  });

  it('toggle hides a visible window and shows a hidden one', async () => {
    const w = fakeWindow();
    const c = new VisibilityController(w, async () => {}, OPTS);
    await c.toggle();
    expect(w.visible).toBe(false);
    await c.toggle();
    expect(w.visible).toBe(true);
    expect(w.events).toEqual(['hide', 'show', 'focus']);
  });

  it('serialises rapid toggles: each one sees the result of the last', async () => {
    const w = fakeWindow();
    const c = new VisibilityController(w, async () => {}, OPTS);
    await Promise.all([c.toggle(), c.toggle(), c.toggle()]);
    expect(w.events).toEqual(['hide', 'show', 'focus', 'hide']);
    expect(w.visible).toBe(false);
  });

  it('does nothing to a destroyed window', async () => {
    const w = fakeWindow();
    w.destroyed = true;
    const c = new VisibilityController(w, async () => {}, OPTS);
    await c.toggle();
    await c.show();
    await c.hide('panic');
    expect(w.events).toEqual([]);
  });

  it('does not conceal or hide an already hidden window', async () => {
    const w = fakeWindow(false);
    const conceal = vi.fn(async () => {});
    const c = new VisibilityController(w, conceal, OPTS);
    await c.hide('cli');
    expect(conceal).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });
});
