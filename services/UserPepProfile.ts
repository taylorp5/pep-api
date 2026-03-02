import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'userPepProfile';

type StoredProfile = {
  intentCounts: Record<string, number>;
  intensityCounts: Record<string, number>;
  voiceProfileCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  obstacleCounts: Record<string, number>;
};

export type UserPepProfileSummary = {
  topIntents: string[];
  mostUsedIntensity: string;
  mostUsedVoiceProfile: string;
  commonOutcome: string | null;
  commonObstacle: string | null;
  profileSummary: string;
};

const DEFAULT_PROFILE: StoredProfile = {
  intentCounts: {},
  intensityCounts: {},
  voiceProfileCounts: {},
  outcomeCounts: {},
  obstacleCounts: {},
};

function getTopKeys(counts: Record<string, number>, limit: number): string[] {
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

function getTopKey(counts: Record<string, number>): string {
  const top = getTopKeys(counts, 1);
  return top[0] || '';
}

export async function loadUserPepProfile(): Promise<StoredProfile> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed = JSON.parse(raw);
    return {
      intentCounts: parsed.intentCounts ?? {},
      intensityCounts: parsed.intensityCounts ?? {},
      voiceProfileCounts: parsed.voiceProfileCounts ?? {},
      outcomeCounts: parsed.outcomeCounts ?? {},
      obstacleCounts: parsed.obstacleCounts ?? {},
    };
  } catch (e) {
    console.warn('[UserPepProfile] load failed:', e);
    return { ...DEFAULT_PROFILE };
  }
}

export async function recordPepProfileUsage(params: {
  intents: string[];
  intensity: string;
  voiceProfileId: string;
  outcome: string | null;
  obstacle: string | null;
}): Promise<void> {
  const profile = await loadUserPepProfile();
  for (const i of params.intents) {
    if (i && i.trim()) {
      const key = i.trim();
      profile.intentCounts[key] = (profile.intentCounts[key] ?? 0) + 1;
    }
  }
  if (params.intensity) {
    profile.intensityCounts[params.intensity] = (profile.intensityCounts[params.intensity] ?? 0) + 1;
  }
  if (params.voiceProfileId) {
    profile.voiceProfileCounts[params.voiceProfileId] = (profile.voiceProfileCounts[params.voiceProfileId] ?? 0) + 1;
  }
  if (params.outcome && params.outcome.trim()) {
    const k = params.outcome.trim();
    profile.outcomeCounts[k] = (profile.outcomeCounts[k] ?? 0) + 1;
  }
  if (params.obstacle && params.obstacle.trim()) {
    const k = params.obstacle.trim();
    profile.obstacleCounts[k] = (profile.obstacleCounts[k] ?? 0) + 1;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export async function getUserPepProfileSummary(): Promise<UserPepProfileSummary> {
  const profile = await loadUserPepProfile();
  const topIntents = getTopKeys(profile.intentCounts, 5);
  const mostUsedIntensity = getTopKey(profile.intensityCounts) || 'direct';
  const mostUsedVoiceProfile = getTopKey(profile.voiceProfileCounts) || 'coach_m';
  const commonOutcome = getTopKey(profile.outcomeCounts) || null;
  const commonObstacle = getTopKey(profile.obstacleCounts) || null;

  const parts: string[] = [];
  if (topIntents.length > 0) {
    parts.push(`User often requests ${topIntents.join(' + ').toLowerCase()}`);
  }
  parts.push(`prefers ${mostUsedIntensity.replace(/_/g, '-')} intensity`);
  if (commonOutcome) {
    parts.push(`wants ${commonOutcome.toLowerCase()}`);
  }
  if (commonObstacle) {
    parts.push(`obstacle: ${commonObstacle.toLowerCase()}`);
  }
  const profileSummary = parts.length > 0
    ? parts.join(', ') + '.'
    : 'User has no usage history yet.';

  return {
    topIntents,
    mostUsedIntensity,
    mostUsedVoiceProfile,
    commonOutcome: commonOutcome || null,
    commonObstacle: commonObstacle || null,
    profileSummary,
  };
}
