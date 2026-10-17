/**
 * Local-only usage telemetry — the set of UI actions we count, their labels, and the
 * shapes crossing IPC. This records ONLY static action IDs, counts and timestamps:
 * never commands, transcripts, prompts, AI answers, screenshots, audio, secrets or any
 * personal data. Nothing here leaves the machine (no MongoDB, no phone, no AI provider).
 *
 * The purpose is product data: which features get used, so unused ones can be retired.
 * The IDs are a single centralized list so the renderer can only ever track a known action
 * (the type is a closed union) and the main process can reject anything else.
 */
export const USAGE_ACTIONS = [
  // Side panels / header (opened via button or shortcut).
  'panel.library',
  'panel.settings',
  'panel.ai',
  'panel.audio',
  'panel.practice',
  'panel.companion',
  'panel.live',
  'hide.panic',
  // Terminal tabs.
  'terminal.newTab',
  'terminal.closeTab',
  'terminal.nextTab',
  'terminal.prevTab',
  // AI.
  'ai.explain',
  'ai.autoExplain',
  // Live transcript.
  'live.start',
  'live.ask',
  'live.askSelected',
  'live.summarize',
  'live.clear',
  'live.export',
  'live.copy',
  'live.speakerMode',
  // Snippet library.
  'library.create',
  'library.paste',
  'library.search',
  // Share to phone.
  'companion.start',
  'companion.forget',
] as const;

export type UsageAction = (typeof USAGE_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(USAGE_ACTIONS);

/** A string is a known, trackable action ID. The only gate the store trusts. */
export function isUsageAction(s: string): s is UsageAction {
  return ACTION_SET.has(s);
}

/** Human labels for the Settings → Usage table. */
export const USAGE_ACTION_LABELS: Record<UsageAction, string> = {
  'panel.library': 'Open snippet library',
  'panel.settings': 'Open settings',
  'panel.ai': 'Open Explain panel',
  'panel.audio': 'Open mic panel',
  'panel.practice': 'Open interview practice',
  'panel.companion': 'Open Share-to-phone',
  'panel.live': 'Open live transcript',
  'hide.panic': 'Hide now (panic)',
  'terminal.newTab': 'New terminal tab',
  'terminal.closeTab': 'Close terminal tab',
  'terminal.nextTab': 'Next tab',
  'terminal.prevTab': 'Previous tab',
  'ai.explain': 'Explain output with AI',
  'ai.autoExplain': 'Auto-explain detected error',
  'live.start': 'Start live transcript',
  'live.ask': 'Ask AI about a line',
  'live.askSelected': 'Ask AI about selected lines',
  'live.summarize': 'Summarize conversation',
  'live.clear': 'Clear conversation',
  'live.export': 'Export transcript (.md)',
  'live.copy': 'Copy transcript',
  'live.speakerMode': 'Change speaker mode',
  'library.create': 'Create snippet',
  'library.paste': 'Paste snippet into terminal',
  'library.search': 'Search snippets',
  'companion.start': 'Start sharing to phone',
  'companion.forget': 'Forget paired phones',
};

export interface UsageEntry {
  count: number;
  /** ISO timestamp of the most recent use. */
  lastUsed: string;
}

/** action ID → counter. Persisted shape (on disk) and in-memory shape. */
export type UsageCounts = Record<string, UsageEntry>;

export interface UsageRow {
  action: UsageAction;
  label: string;
  count: number;
  /** null if never used. */
  lastUsed: string | null;
}

export interface UsageView {
  /** Every known action, most-used first; actions never used appear with count 0. */
  rows: UsageRow[];
  total: number;
  file: string;
  /** Set when the file was unreadable and was reset. */
  loadWarning: string | null;
}
