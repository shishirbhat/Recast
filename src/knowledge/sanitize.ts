import { homedir } from "node:os";

/**
 * Redaction for anything people paste into shared records (logs, stack traces, command output).
 * It is a safety net, not a guarantee: it catches common credential shapes and machine paths. Every redaction is counted
 * so a record shows that something was removed.
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted github token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted api key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted aws key]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, "[redacted slack token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted jwt]"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1=[redacted]"],
];

export interface Sanitized {
  text: string;
  redactions: number;
}

export function sanitize(input: string, root?: string): Sanitized {
  let text = input;
  let redactions = 0;
  for (const [re, rep] of PATTERNS) {
    text = text.replace(re, (...m) => {
      redactions++;
      return rep.replace("$1", String(m[1] ?? ""));
    });
  }
  // Machine paths: the project root becomes <project>, the home directory ~.
  if (root) text = text.split(root).join("<project>");
  const home = homedir();
  if (home && home.length > 1) text = text.split(home).join("~");
  return { text, redactions };
}
