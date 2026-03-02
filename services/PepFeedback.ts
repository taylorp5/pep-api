import AsyncStorage from '@react-native-async-storage/async-storage';

const FEEDBACK_LOG_KEY = 'pepFeedbackLog';
const DEFAULT_HONESTY_KEY = 'defaultHonestyLevel';
const SKIP_FEEDBACK_AFTER_PEP_KEY = 'skipFeedbackAfterPep';

const MIN_LEVEL = 1;
const MAX_LEVEL = 5;

export type FeedbackRating = 'yeah' | 'not_really';
export type FeedbackReason = 'too_soft' | 'too_intense' | 'too_generic' | 'too_long';

export type PepFeedbackEntry = {
  id: string;
  kind: 'daily' | 'custom';
  date: string; // ISO
  rating: FeedbackRating;
  reason?: FeedbackReason;
  feedbackText?: string; // optional open-ended feedback
};

export async function loadFeedbackLog(): Promise<PepFeedbackEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(FEEDBACK_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[PepFeedback] loadFeedbackLog failed:', e);
    return [];
  }
}

export async function saveFeedback(entry: PepFeedbackEntry): Promise<void> {
  const log = await loadFeedbackLog();
  log.push(entry);
  await AsyncStorage.setItem(FEEDBACK_LOG_KEY, JSON.stringify(log));
}

export async function getDefaultHonestyLevel(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(DEFAULT_HONESTY_KEY);
    if (raw == null) return 3;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return 3;
    return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, n));
  } catch (e) {
    return 3;
  }
}

export async function setDefaultHonestyLevel(level: number): Promise<void> {
  const clamped = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
  await AsyncStorage.setItem(DEFAULT_HONESTY_KEY, String(clamped));
}

export async function getSkipFeedbackAfterPep(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SKIP_FEEDBACK_AFTER_PEP_KEY);
    return raw === 'true';
  } catch (e) {
    return false;
  }
}

export async function setSkipFeedbackAfterPep(skip: boolean): Promise<void> {
  await AsyncStorage.setItem(SKIP_FEEDBACK_AFTER_PEP_KEY, skip ? 'true' : 'false');
}

/**
 * Adjust default intensity by one step based on reason.
 * "Too soft" -> increase (max 5). "Too intense" -> decrease (min 1).
 */
export async function adjustDefaultHonestyFromFeedback(reason: FeedbackReason): Promise<number> {
  if (reason !== 'too_soft' && reason !== 'too_intense') return await getDefaultHonestyLevel();
  const current = await getDefaultHonestyLevel();
  const next =
    reason === 'too_soft'
      ? Math.min(MAX_LEVEL, current + 1)
      : Math.max(MIN_LEVEL, current - 1);
  await setDefaultHonestyLevel(next);
  return next;
}
