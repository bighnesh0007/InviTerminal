/**
 * Masks obvious secrets before terminal text is sent to Anthropic. This is a
 * best-effort safety net, NOT a guarantee — it reduces accidental leaks of
 * common credential shapes; it cannot catch every secret. The UI says so.
 *
 * Shared so the renderer can preview exactly what the main process will send;
 * the main process re-applies it authoritatively (never trusts the renderer).
 */

export interface Redaction {
  /** What was masked, for the preview, e.g. "AWS access key id". */
  label: string;
}

export interface RedactResult {
  redacted: string;
  redactions: Redaction[];
}

interface Rule {
  label: string;
  re: RegExp;
  /** Which capture group to mask; 0 = whole match. */
  group?: number;
}

const PLACEHOLDER = '«redacted:LABEL»';

// Ordered: more specific patterns first. All global + multiline.
const RULES: Rule[] = [
  // KEY=secret or KEY: secret for names that look sensitive; mask the value only.
  { label: 'secret assignment', re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(?:"([^"]+)"|'([^']+)'|(\S+))/gi, group: 0 },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { label: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { label: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { label: 'AWS access key id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'bearer token', re: /\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, group: 2 },
  { label: 'basic auth in URL', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, group: 2 },
];

/** A secret assignment keeps its name but masks the value. Returns the replacement string. */
function maskAssignment(match: string, name: string, sep: string): string {
  return `${name}${sep}${PLACEHOLDER.replace('LABEL', 'value')}`;
}

export function redactSecrets(text: string): RedactResult {
  let out = text;
  const redactions: Redaction[] = [];
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      redactions.push({ label: rule.label });
      if (rule.label === 'secret assignment') return maskAssignment(groups[0]!, groups[1]!, groups[2]!);
      const token = PLACEHOLDER.replace('LABEL', rule.label);
      if (rule.group && groups[rule.group] !== undefined) {
        // Keep the non-secret prefix (e.g. "Bearer ", "user:"), mask the captured secret.
        return groups[0]!.replace(groups[rule.group]!, token);
      }
      return token;
    });
  }
  return { redacted: out, redactions };
}

/** Short summary for the preview, e.g. "2 secrets masked (Anthropic API key, bearer token)". */
export function summarizeRedactions(redactions: readonly Redaction[]): string {
  if (redactions.length === 0) return 'No obvious secrets detected (the redactor is best-effort, not a guarantee).';
  const labels = [...new Set(redactions.map((r) => r.label))];
  return `${redactions.length} secret${redactions.length > 1 ? 's' : ''} masked (${labels.join(', ')}).`;
}
