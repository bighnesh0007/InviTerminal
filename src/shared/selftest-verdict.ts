export type Verdict = 'pass' | 'fail' | 'inconclusive';

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

/**
 * The control canary sits in an unprotected window. If it is missing, the
 * capture itself (or the detector) did not work, so "protected canary not
 * found" proves nothing — that is the case this function exists to catch.
 */
export function judge(protectedFound: boolean, controlFound: boolean): VerdictResult {
  if (protectedFound) {
    return { verdict: 'fail', reason: 'Protected window content was visible in the capture.' };
  }
  if (!controlFound) {
    return {
      verdict: 'inconclusive',
      reason: 'The unprotected control window was not found either, so the capture cannot be trusted.',
    };
  }
  return { verdict: 'pass', reason: 'Control window captured; protected window absent.' };
}
