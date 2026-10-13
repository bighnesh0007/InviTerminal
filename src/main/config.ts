import { z } from 'zod';

/** The only place environment variables are read. */
const EnvSchema = z.object({
  INVI_RECHECK_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(10_000),
  /** Development aid: run the screenshot self-test (negative control, then protected) on start, log JSON, and quit. */
  INVI_AUTOTEST: z.enum(['off', 'screenshot']).default('off'),
});

const env = EnvSchema.parse(process.env);

/** Session variables used only to pick a capture-exclusion provider. */
const SessionSchema = z.object({
  XDG_SESSION_TYPE: z.string().optional(),
  XDG_CURRENT_DESKTOP: z.string().optional(),
  WAYLAND_DISPLAY: z.string().optional(),
  DISPLAY: z.string().optional(),
});

export const sessionEnv: Readonly<Record<string, string | undefined>> = SessionSchema.parse(process.env);

export const config = {
  /** Neutral on purpose: the title shows up in screen-share pickers and task switchers. */
  mainTitle: 'InviTerminal',
  /** Must differ from mainTitle — the KWin provider identifies the main window by exact caption. */
  controlTitle: 'InviTerminal control canary (NOT protected)',
  recheckIntervalMs: env.INVI_RECHECK_INTERVAL_MS,
  autotest: env.INVI_AUTOTEST,
  canaryPaintTimeoutMs: 3000,
  /** Extra time for a painted frame to reach the compositor. */
  compositorSettleMs: 250,
  screenshotTimeoutMs: 15_000,
  screencastTimeoutMs: 120_000,
} as const;
