export interface CredentialRange {
  start: number;
  end: number;
}

// Display heuristics only: this deliberately does not attempt to find every
// password. Offsets use JavaScript string indices (UTF-16), never decoded URLs.
// CJK prose commonly touches a key directly (e.g. “密钥sk-...”); only ASCII
// token characters make it part of a larger word.
const wordEnd = /[A-Za-z0-9_-]$/;
const wordStart = /^[A-Za-z0-9_-]/;

function hasBoundaries(text: string, start: number, end: number): boolean {
  return !wordEnd.test(text.slice(Math.max(0, start - 2), start)) &&
    !wordStart.test(text.slice(end, end + 2));
}

function isKnownToken(token: string): boolean {
  return /^(?:sk-|gh[pousr]_|github_pat_|glpat-|npm_|hf_|sk_live_|sk_test_|rk_|whsec_)[A-Za-z0-9_-]{20,}$/.test(token) ||
    /^AIza[A-Za-z0-9_-]{35}$/.test(token) ||
    /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(token) ||
    /^xox[baprsce]-[A-Za-z0-9_-]{20,}$/.test(token);
}

export function findCredentials(text: string): CredentialRange[] {
  const ranges: CredentialRange[] = [];

  // Consume each PEM block once. An unfinished block hides the rest of the
  // message, including any key material after its last newline.
  const pem = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----/g;
  let match: RegExpExecArray | null;
  while ((match = pem.exec(text)) !== null) {
    const closing = `-----END ${match[1]}-----`;
    const closeAt = text.indexOf(closing, pem.lastIndex);
    const end = closeAt < 0 ? text.length : closeAt + closing.length;
    ranges.push({ start: match.index, end });
    if (closeAt < 0) break;
    pem.lastIndex = end;
  }

  // Scan maximal token runs first. Anchored checks cannot repeatedly rescan a
  // long malformed JWT suffix at every occurrence of "eyJ".
  const tokens = /[A-Za-z0-9_-]+/g;
  let previous: CredentialRange | undefined;
  let beforePrevious: CredentialRange | undefined;
  while ((match = tokens.exec(text)) !== null) {
    const current = { start: match.index, end: tokens.lastIndex };
    if (isKnownToken(match[0]) && hasBoundaries(text, current.start, current.end)) {
      ranges.push(current);
    }
    if (beforePrevious && previous &&
        previous.start === beforePrevious.end + 1 && text[beforePrevious.end] === '.' &&
        current.start === previous.end + 1 && text[previous.end] === '.' &&
        beforePrevious.end - beforePrevious.start >= 8 &&
        text.startsWith('eyJ', beforePrevious.start) &&
        previous.end - previous.start >= 8 && current.end - current.start >= 8 &&
        hasBoundaries(text, beforePrevious.start, current.end)) {
      ranges.push({ start: beforePrevious.start, end: current.end });
    }
    beforePrevious = previous;
    previous = current;
  }

  // Find the fixed delimiter, then walk its scheme/authority. Starting a greedy
  // scheme regex at every letter could take quadratic time on malformed input.
  const urlDelimiter = /:\/\//g;
  const schemeChar = /[A-Za-z0-9+.-]/;
  const authorityEnd = /[\s/\?#<>"'`]/u;
  while ((match = urlDelimiter.exec(text)) !== null) {
    let schemeStart = match.index;
    while (schemeStart > 0 && schemeChar.test(text[schemeStart - 1])) schemeStart--;
    if (!/^[A-Za-z]$/.test(text[schemeStart]) ||
        wordEnd.test(text.slice(Math.max(0, schemeStart - 2), schemeStart))) continue;
    const start = urlDelimiter.lastIndex;
    let end = start;
    let colon = -1;
    let at = -1;
    while (end < text.length && !authorityEnd.test(text[end])) {
      if (text[end] === ':' && colon < 0) colon = end;
      if (text[end] === '@') at = end;
      end++;
    }
    urlDelimiter.lastIndex = end;
    if (colon > start && at > colon + 1 && at + 1 < end) {
      ranges.push({ start: colon + 1, end: at });
    }
  }

  const bearer = /\bAuthorization[ \t]*:[ \t]*Bearer[ \t]+/gi;
  const bearerEnd = /[\s"'`,;<>]/u;
  while ((match = bearer.exec(text)) !== null) {
    if (wordEnd.test(text.slice(Math.max(0, match.index - 2), match.index))) continue;
    const start = bearer.lastIndex;
    let end = start;
    while (end < text.length && !bearerEnd.test(text[end])) end++;
    if (end > start) ranges.push({ start, end });
    bearer.lastIndex = end;
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CredentialRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// `revealed` contains zero-based indices into the supplied, ordered ranges.
// Reject invalid caller ranges instead of silently emitting partially masked data.
export function displayCredentials(
  text: string,
  ranges: readonly CredentialRange[],
  revealed?: ReadonlySet<number>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < cursor || range.end <= range.start || range.end > text.length) {
      throw new RangeError('Credential ranges must be ordered, disjoint UTF-16 offsets within the text');
    }
    parts.push(text.slice(cursor, range.start));
    parts.push(revealed?.has(index)
      ? text.slice(range.start, range.end)
      : `〔凭据 ${index + 1} 已隐藏〕`);
    cursor = range.end;
  });
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function maskCredentials(text: string): string {
  return displayCredentials(text, findCredentials(text));
}
