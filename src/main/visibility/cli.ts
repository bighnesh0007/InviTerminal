export type CliAction = 'toggle' | 'show' | 'hide';

const FLAGS: Record<string, CliAction> = {
  '--toggle': 'toggle',
  '--show': 'show',
  '--hide': 'hide',
};

/**
 * Reads the visibility action from a command line. A second instance's argv
 * also carries Electron/Chromium switches and the app path, so only exact
 * matches count; anything else is ignored, never interpreted.
 */
export function parseCliAction(argv: readonly string[]): CliAction | null {
  for (const arg of argv) {
    const action = FLAGS[arg];
    if (action) return action;
  }
  return null;
}
