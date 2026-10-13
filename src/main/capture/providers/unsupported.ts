import type { CaptureExclusionProvider } from '../types';

export function createUnsupportedProvider(reason: string): CaptureExclusionProvider {
  return {
    id: 'unsupported',
    probe: async () => ({ supported: false, reason, knownGaps: [] }),
    apply: async () => ({ ok: false, error: reason }),
    readBack: async () => ({ excluded: 'unknown', detail: reason }),
  };
}
