/**
 * Derive a human-readable default title for a custom pep from user input.
 * Max 40 characters; sentence case; no title-casing every word.
 */

const MAX_LEN = 40;
const TRUNCATE_AT = 37;
const TRUNCATE_SUFFIX = '...';

const LEADING_PHRASES = [
  /^I want to\s+/i,
  /^I need to\s+/i,
  /^I don't want to\s+/i,
  /^I dont want to\s+/i,
  /^Help me\s+/i,
  /^Motivation to\s+/i,
];

function sentenceCase(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function trimPunctuation(s: string): string {
  return s.replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, '').trim();
}

function cleanFromUserText(raw: string): string {
  let t = raw.trim();
  for (const re of LEADING_PHRASES) {
    t = t.replace(re, '');
  }
  t = trimPunctuation(t);
  return t;
}

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  const cut = s.slice(0, TRUNCATE_AT);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > TRUNCATE_AT / 2) {
    return cut.slice(0, lastSpace).trim() + TRUNCATE_SUFFIX;
  }
  return cut + TRUNCATE_SUFFIX;
}

export type DerivePepTitleInput = {
  userText: string;
  outcome: string | null;
  obstacle: string | null;
};

/**
 * Returns a default title for a custom pep.
 * Rules: A) outcome + obstacle -> "X despite y"; B) outcome only; C) short userText (cleaned);
 * D) long userText (first sentence or 8–12 words, cleaned); E) "Custom Pep".
 * Max 40 chars; sentence case.
 */
export function derivePepTitle(input: DerivePepTitleInput): string {
  const { userText, outcome, obstacle } = input;
  const user = userText.trim();

  // A) outcome + obstacle
  if (outcome && obstacle) {
    const o = sentenceCase(outcome.trim());
    const obs = obstacle.trim().toLowerCase();
    const raw = `${o} despite ${obs}`;
    return truncate(raw);
  }

  // B) outcome only
  if (outcome) {
    const raw = sentenceCase(outcome.trim());
    return truncate(raw);
  }

  // C) short userText (<= 60 chars)
  if (user.length > 0 && user.length <= 60) {
    const cleaned = cleanFromUserText(user);
    if (cleaned) return truncate(cleaned);
  }

  // D) long userText: first sentence or first 8–12 words, then clean
  if (user.length > 60) {
    const firstSentence = user.match(/^[^.!?\n]+/)?.[0]?.trim();
    const words = user.split(/\s+/).filter(Boolean);
    const firstWords = words.slice(0, 10).join(' ');
    const source = (firstSentence && firstSentence.length <= 80 ? firstSentence : firstWords).trim();
    const cleaned = cleanFromUserText(source);
    if (cleaned) return truncate(cleaned);
  }

  // E) fallback
  return 'Custom Pep';
}
