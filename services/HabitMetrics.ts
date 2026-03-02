import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  LAST_DAILY_PEP_PLAYED_DATE: 'habit_lastDailyPepPlayedDate',
  STREAK_COUNT: 'habit_streakCount',
  TOTAL_PEPS_PLAYED: 'habit_totalPepsPlayed',
  TOTAL_CUSTOM_PEPS_GENERATED: 'habit_totalCustomPepsGenerated',
  TOTAL_MINUTES_LISTENED: 'habit_totalMinutesListened',
} as const;

export type HabitMetrics = {
  lastDailyPepPlayedDate: string | null;
  streakCount: number;
  totalPepsPlayed: number;
  totalCustomPepsGenerated: number;
  totalMinutesListened: number;
};

const defaults: HabitMetrics = {
  lastDailyPepPlayedDate: null,
  streakCount: 0,
  totalPepsPlayed: 0,
  totalCustomPepsGenerated: 0,
  totalMinutesListened: 0,
};

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function loadHabitMetrics(): Promise<HabitMetrics> {
  try {
    const [lastDate, streak, pepsPlayed, customGenerated, minutes] = await AsyncStorage.multiGet([
      KEYS.LAST_DAILY_PEP_PLAYED_DATE,
      KEYS.STREAK_COUNT,
      KEYS.TOTAL_PEPS_PLAYED,
      KEYS.TOTAL_CUSTOM_PEPS_GENERATED,
      KEYS.TOTAL_MINUTES_LISTENED,
    ]);
    return {
      lastDailyPepPlayedDate: lastDate[1] ?? null,
      streakCount: Math.max(0, parseInt(streak[1] ?? '0', 10) || 0),
      totalPepsPlayed: Math.max(0, parseInt(pepsPlayed[1] ?? '0', 10) || 0),
      totalCustomPepsGenerated: Math.max(0, parseInt(customGenerated[1] ?? '0', 10) || 0),
      totalMinutesListened: Math.max(0, parseFloat(minutes[1] ?? '0') || 0),
    };
  } catch (e) {
    console.warn('[HabitMetrics] load failed:', e);
    return { ...defaults };
  }
}

/**
 * Call when the user finishes playing the Daily Pep (playback didJustFinish for daily).
 * Updates lastDailyPepPlayedDate and streak.
 * - If already played today: no change.
 * - If last was yesterday: streak += 1.
 * - If last was older or never: streak = 1.
 */
export async function recordDailyPepPlayed(): Promise<{ streakCount: number; lastDailyPepPlayedDate: string }> {
  const today = todayKey();
  const yesterday = yesterdayKey();
  const metrics = await loadHabitMetrics();
  const last = metrics.lastDailyPepPlayedDate;

  if (last === today) {
    return { streakCount: metrics.streakCount, lastDailyPepPlayedDate: today };
  }

  let newStreak: number;
  if (last === yesterday) {
    newStreak = metrics.streakCount + 1;
  } else {
    newStreak = 1;
  }

  await AsyncStorage.multiSet([
    [KEYS.LAST_DAILY_PEP_PLAYED_DATE, today],
    [KEYS.STREAK_COUNT, String(newStreak)],
  ]);
  return { streakCount: newStreak, lastDailyPepPlayedDate: today };
}

/**
 * Call when any pep playback finishes. Increments totalPepsPlayed and adds minutes.
 */
export async function recordPepPlayed(minutesListened: number = 0): Promise<void> {
  const metrics = await loadHabitMetrics();
  const newPeps = metrics.totalPepsPlayed + 1;
  const newMinutes = metrics.totalMinutesListened + minutesListened;
  await AsyncStorage.multiSet([
    [KEYS.TOTAL_PEPS_PLAYED, String(newPeps)],
    [KEYS.TOTAL_MINUTES_LISTENED, String(Math.round(newMinutes * 10) / 10)],
  ]);
}

/**
 * Call when a custom pep is successfully generated.
 */
export async function recordCustomPepGenerated(): Promise<void> {
  const metrics = await loadHabitMetrics();
  await AsyncStorage.setItem(
    KEYS.TOTAL_CUSTOM_PEPS_GENERATED,
    String(metrics.totalCustomPepsGenerated + 1)
  );
}

export { todayKey as getTodayKey };
