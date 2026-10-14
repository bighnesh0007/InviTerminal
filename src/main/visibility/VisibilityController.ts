/** The parts of BrowserWindow this controller needs, so tests can use a fake. */
export interface WindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
}

export type HideReason = 'toggle' | 'panic' | 'tray' | 'cli';

export interface VisibilityOptions {
  /** How long a normal hide waits for the renderer to confirm it has covered the content. */
  concealTimeoutMs: number;
  /** Panic hide waits less: getting the window off screen matters more than a clean cover. */
  panicConcealTimeoutMs: number;
}

export const DEFAULT_VISIBILITY_OPTIONS: VisibilityOptions = { concealTimeoutMs: 300, panicConcealTimeoutMs: 80 };

export interface HideResult {
  concealed: boolean;
  ms: number;
}

/**
 * Showing a hidden window on Wayland creates a new, unprotected KWin window,
 * and protection is only re-applied after it is mapped. So before every hide
 * the renderer is told to cover the content and confirm it painted the
 * cover; the first frames after the next show are then the cover, not the
 * terminal. If the renderer does not confirm in time the window is hidden
 * anyway — hiding is the safe direction.
 */
export class VisibilityController {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly win: WindowLike,
    private readonly conceal: () => Promise<void>,
    private readonly opts: VisibilityOptions = DEFAULT_VISIBILITY_OPTIONS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private run<T>(op: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  hide(reason: HideReason): Promise<HideResult> {
    return this.run(() => this.doHide(reason));
  }

  show(): Promise<void> {
    return this.run(() => this.doShow());
  }

  /** One queued step, so nothing can change visibility between the check and the action. */
  toggle(): Promise<'hidden' | 'shown' | 'none'> {
    return this.run(async () => {
      if (this.win.isDestroyed()) return 'none';
      if (this.win.isVisible()) {
        await this.doHide('toggle');
        return 'hidden';
      }
      this.doShow();
      return 'shown';
    });
  }

  private async doHide(reason: HideReason): Promise<HideResult> {
    const start = this.now();
    if (this.win.isDestroyed() || !this.win.isVisible()) return { concealed: false, ms: 0 };
    const timeout = reason === 'panic' ? this.opts.panicConcealTimeoutMs : this.opts.concealTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const concealed = await Promise.race([
      this.conceal().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeout);
      }),
    ]);
    clearTimeout(timer);
    if (!this.win.isDestroyed()) this.win.hide();
    return { concealed, ms: this.now() - start };
  }

  private doShow(): void {
    if (this.win.isDestroyed()) return;
    if (!this.win.isVisible()) this.win.show();
    this.win.focus();
  }
}
