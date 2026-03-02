import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

export type PepItem = {
  id: string;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  kind: 'daily' | 'custom';
  title: string;
  text: string | null;
  audioUriLocal: string;
  audioUrlRemote: string | null;
  voiceProfileId: string;
  intensityLevel: string | number;
  lengthSecondsRequested: number;
  outcome: string | null;
  obstacle: string | null;
  isSaved: boolean;
  needsSync: boolean;
  /** Flow Continue Session: same id for all parts of one session */
  sessionId?: string | null;
  /** Flow Continue Session: 0 = first part, 1 = first continuation, etc. */
  sessionPartIndex?: number;
};

const STORAGE_KEY = 'pepLibrary';
const LEGACY_KEY = 'savedPepTalks';

/** Verify audio file exists at URI before playback. Use this to avoid silent failures. */
export async function audioFileExists(uri: string): Promise<boolean> {
  if (!uri) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists === true;
  } catch {
    return false;
  }
}

type LegacySavedPepTalk = {
  id: string;
  createdAt: string;
  title: string;
  topic?: string;
  scriptText: string;
  voice: string;
  audioFileUri: string;
  durationSeconds?: number;
  tone?: string;
  tier?: string;
};

function generateId(): string {
  // Simple UUID v4-style generator (sufficient for local IDs)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function titleFromText(text: string, topic?: string | null): string {
  const words = text.trim().split(/\s+/).slice(0, 3).join(' ');
  if (topic) return topic;
  return words.length > 20 ? words.substring(0, 20) + '...' : words;
}

function normalizePep(raw: any): PepItem {
  const now = Date.now();

  const createdAt =
    typeof raw.createdAt === 'number'
      ? raw.createdAt
      : raw.createdAt
      ? new Date(raw.createdAt).getTime()
      : now;

  const audioUriLocal =
    raw.audioUriLocal ??
    raw.audioUri ??
    raw.audioFileUri ??
    '';

  const lengthSecondsRequested =
    typeof raw.lengthSecondsRequested === 'number'
      ? raw.lengthSecondsRequested
      : typeof raw.lengthSeconds === 'number'
      ? raw.lengthSeconds
      : typeof raw.durationSeconds === 'number'
      ? raw.durationSeconds
      : 0;

  const voiceProfileId = raw.voiceProfileId ?? raw.voice ?? '';
  const intensityLevel = raw.intensityLevel ?? raw.tone ?? 'direct';

  const userId = raw.userId ?? null;
  const title =
    raw.title ??
    titleFromText(raw.text ?? raw.scriptText ?? '', raw.topic);

  const text = raw.text ?? raw.scriptText ?? null;

  const updatedAt =
    typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt;

  const isSaved = raw.isSaved !== false;

  const needsSync =
    typeof raw.needsSync === 'boolean'
      ? raw.needsSync
      : userId == null;

  const kind: 'daily' | 'custom' =
    raw.kind === 'daily' || raw.kind === 'custom' ? raw.kind : 'custom';

  const sessionId = raw.sessionId ?? null;
  const sessionPartIndex = typeof raw.sessionPartIndex === 'number' ? raw.sessionPartIndex : undefined;

  return {
    id: raw.id ?? generateId(),
    userId,
    createdAt,
    updatedAt,
    kind,
    title,
    text,
    audioUriLocal,
    audioUrlRemote: raw.audioUrlRemote ?? null,
    voiceProfileId,
    intensityLevel,
    lengthSecondsRequested,
    outcome: raw.outcome ?? null,
    obstacle: raw.obstacle ?? null,
    isSaved,
    needsSync,
    ...(sessionId != null ? { sessionId } : {}),
    ...(sessionPartIndex !== undefined ? { sessionPartIndex } : {}),
  };
}

/** Migrate legacy saved pep talks into PepItem[] and write to STORAGE_KEY */
async function migrateLegacy(): Promise<PepItem[]> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const legacy: LegacySavedPepTalk[] = JSON.parse(raw);
    const items: PepItem[] = legacy.map((p) => ({
      id: p.id,
      userId: null,
      createdAt: new Date(p.createdAt).getTime(),
      updatedAt: new Date(p.createdAt).getTime(),
      kind: 'custom' as const,
      title: p.title,
      text: p.scriptText ?? null,
      audioUriLocal: p.audioFileUri,
      audioUrlRemote: null,
      voiceProfileId: p.voice,
      intensityLevel: p.tone ?? 'direct',
      lengthSecondsRequested: p.durationSeconds ?? 0,
      outcome: null,
      obstacle: null,
      isSaved: true,
      needsSync: true,
    }));
    if (items.length > 0) {
      const sorted = items.sort((a, b) => b.createdAt - a.createdAt);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
      await AsyncStorage.removeItem(LEGACY_KEY);
      return sorted;
    }
  } catch (e) {
    console.warn('[PepLibrary] Legacy migration failed:', e);
  }
  return [];
}

export async function loadSavedPeps(): Promise<PepItem[]> {
  try {
    let raw = await AsyncStorage.getItem(STORAGE_KEY);
    let saved: PepItem[];
    if (!raw) {
      const migrated = await migrateLegacy();
      saved = migrated.length > 0 ? migrated.map((p) => normalizePep(p)) : [];
    } else {
      const parsed: any[] = JSON.parse(raw);
      const normalized = parsed.map((p) => normalizePep(p));
      saved = normalized.filter((p) => p.isSaved !== false);
    }
    const valid: PepItem[] = [];
    for (const p of saved) {
      const exists = await audioFileExists(p.audioUriLocal);
      if (!exists) {
        console.warn('[PepLibrary] Missing audio file, removed from library:', p.id, p.title ?? '(no title)', p.audioUriLocal);
      } else {
        valid.push(p);
      }
    }
    if (valid.length !== saved.length) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
    } else if (saved.length > 0) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    }
    return valid.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.error('[PepLibrary] loadSavedPeps error:', e);
    return [];
  }
}

export type SavePepInput = {
  id?: string;
  userId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  kind: 'daily' | 'custom';
  title: string;
  text: string | null;
  /** Local file URI; file must already be written to device storage (e.g. FileSystem.writeAsStringAsync) before calling savePep. */
  audioUriLocal: string;
  audioUrlRemote?: string | null;
  voiceProfileId: string;
  intensityLevel: string | number;
  lengthSecondsRequested: number;
  outcome?: string | null;
  obstacle?: string | null;
  isSaved?: boolean;
  needsSync?: boolean;
  sessionId?: string | null;
  sessionPartIndex?: number;
};

/** Saves pep metadata to library. Caller must persist the audio file to device storage first (e.g. FileSystem.writeAsStringAsync); audioUriLocal must point to that file. */
export async function savePep(item: SavePepInput): Promise<PepItem> {
  const now = Date.now();
  const full: PepItem = {
    id: item.id ?? generateId(),
    userId: item.userId ?? null,
    createdAt: item.createdAt ?? now,
    updatedAt: item.updatedAt ?? now,
    kind: item.kind,
    title: item.title,
    text: item.text ?? null,
    audioUriLocal: item.audioUriLocal,
    audioUrlRemote: item.audioUrlRemote ?? null,
    voiceProfileId: item.voiceProfileId,
    intensityLevel: item.intensityLevel,
    lengthSecondsRequested: item.lengthSecondsRequested,
    outcome: item.outcome ?? null,
    obstacle: item.obstacle ?? null,
    isSaved: item.isSaved ?? true,
    needsSync:
      typeof item.needsSync === 'boolean'
        ? item.needsSync
        : (item.userId ?? null) == null,
    ...(item.sessionId != null ? { sessionId: item.sessionId } : {}),
    ...(item.sessionPartIndex !== undefined ? { sessionPartIndex: item.sessionPartIndex } : {}),
  };
  const list = await loadSavedPeps();
  const without = list.filter((p) => p.id !== full.id);
  without.unshift(full);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(without));
  return full;
}

export async function unsavePep(id: string): Promise<void> {
  const list = await loadSavedPeps();
  const filtered = list.filter((p) => p.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export async function deletePep(id: string): Promise<void> {
  const list = await loadSavedPeps();
  const target = list.find((p) => p.id === id);
  await unsavePep(id);
  if (target?.audioUriLocal) {
    try {
      await FileSystem.deleteAsync(target.audioUriLocal, { idempotent: true });
    } catch (e) {
      console.warn('[PepLibrary] Failed to delete local audio file:', e);
    }
  }
}

export async function getPepById(id: string): Promise<PepItem | null> {
  const list = await loadSavedPeps();
  return list.find((p) => p.id === id) ?? null;
}

/** Update title for a saved pep (persists to AsyncStorage). Caller should restrict to kind === 'custom'. */
export async function updatePepTitle(id: string, newTitle: string): Promise<void> {
  const list = await loadSavedPeps();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) return;
  const now = Date.now();
  const updated = { ...list[index], title: newTitle.trim() || list[index].title, updatedAt: now };
  list[index] = updated;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Update session fields for Flow Continue Session (so playlist can play parts in order). */
export async function updatePepSession(id: string, sessionId: string, sessionPartIndex: number): Promise<void> {
  const list = await loadSavedPeps();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) return;
  const now = Date.now();
  const updated = { ...list[index], sessionId, sessionPartIndex, updatedAt: now };
  list[index] = updated;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
