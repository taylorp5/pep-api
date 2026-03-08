import { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform, View, ScrollView, Animated, Pressable, Modal, KeyboardAvoidingView, ToastAndroid, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio, InterruptionModeAndroid } from 'expo-av';
import * as Speech from 'expo-speech';
import * as FileSystem from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Constants from 'expo-constants';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useUser } from '@/contexts/UserContext';
import { useAudioPlayback } from '@/contexts/AudioPlaybackContext';
import { savePep, unsavePep, updatePepSession, loadSavedPeps, getPepById, type PepItem } from '@/services/PepLibrary';
import { derivePepTitle } from '@/utils/derivePepTitle';
import { pepTheme } from '@/constants/pep-theme';
import {
  loadHabitMetrics,
  recordDailyPepPlayed,
  recordPepPlayed,
  recordCustomPepGenerated,
  getTodayKey as getHabitTodayKey,
  type HabitMetrics,
} from '@/services/HabitMetrics';
import {
  saveFeedback,
  getDefaultHonestyLevel,
  setDefaultHonestyLevel,
  adjustDefaultHonestyFromFeedback,
  type PepFeedbackEntry,
  type FeedbackReason,
  getSkipFeedbackAfterPep,
  setSkipFeedbackAfterPep,
} from '@/services/PepFeedback';
import { notifyPepReady, isReminderSupported, getPepReadyEnabled } from '@/services/ReminderNotifications';
import { recordPepProfileUsage, getUserPepProfileSummary, type UserPepProfileSummary } from '@/services/UserPepProfile';

// API Configuration
// For now, hard-code the production API so all builds (including store) always use Render.
// If you need local dev against your PC, we can reintroduce env-based overrides separately.
const API_URL = 'https://pep-api-ohvs.onrender.com';

// No fallbacks in production; on error we just report that the hosted API is unreachable.
const FALLBACK_API_URLS: string[] = [];

// Helper function to detect and warn about API_URL configuration
const checkApiUrl = () => {
  console.log(`[API] Platform: ${Platform.OS}, API_URL: ${API_URL}`);
  if (Platform.OS === 'android') {
    if (API_URL.includes('10.0.2.2')) {
      console.log('✅ Using Android emulator IP (10.0.2.2) - make sure API server is running on localhost:3001');
    } else {
      console.warn('⚠️ On Android emulator, consider using 10.0.2.2:3001 to reach host localhost');
    }
  }
  if (API_URL.includes('localhost') || API_URL.includes('127.0.0.1')) {
    console.warn(
      '⚠️ API_URL is set to localhost. For Expo Go on a physical device, change API_URL to your computer\'s LAN IP (e.g., http://192.168.x.x:3001)'
    );
  }
};

const CONNECTION_TEST_TIMEOUT_MS = 25000;
// Allow enough time for cold start + script + TTS (e.g. Render free tier + 2–3 min pep).
const API_REQUEST_TIMEOUT_MS = 150000; // 2.5 min
const MAX_AUDIO_CACHE_FILES = 100;
const PLAY_DEBOUNCE_MS = 1500;

/** Keep at most maxFiles audio files in cacheDir; delete oldest by filename (timestamp in name). */
const pruneAudioCache = async (cacheDir: string, maxFiles: number = MAX_AUDIO_CACHE_FILES): Promise<void> => {
  if (Platform.OS === 'web') return;
  try {
    const readDir = (FileSystem as any).readDirectoryAsync;
    if (typeof readDir !== 'function') return;
    const dirUri = cacheDir.startsWith('file://') ? cacheDir : (cacheDir.includes('://') ? cacheDir : `file://${cacheDir}`);
    const names: string[] = await readDir(dirUri);
    const mp3 = names.filter((n: string) => n.endsWith('.mp3'));
    if (mp3.length <= maxFiles) return;
    mp3.sort((a: string, b: string) => a.localeCompare(b));
    const toDelete = mp3.slice(0, mp3.length - maxFiles);
    const base = cacheDir.endsWith('/') ? cacheDir : `${cacheDir}/`;
    for (const name of toDelete) {
      try {
        await FileSystem.deleteAsync(base + name, { idempotent: true });
      } catch (_) { /* ignore per-file errors */ }
    }
  } catch (_) {
    // readDirectoryAsync may not exist or fail; no-op
  }
};

// Helper function to test API connection (both GET and POST)
// Tries multiple URLs if the primary fails
const testApiConnection = async (urlToTest?: string): Promise<{ success: boolean; error?: string; details?: string; workingUrl?: string }> => {
  const urlsToTry = urlToTest ? [urlToTest] : [API_URL, ...FALLBACK_API_URLS.filter(u => u !== API_URL)];
  
  let lastError: any = null;
  
  const fetchWithTimeout = async (url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> => {
    const { timeoutMs = CONNECTION_TEST_TIMEOUT_MS, ...fetchOpts } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(id);
      return res;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  };

  for (const testUrl of urlsToTry) {
    try {
      console.log('[CONNECTION TEST] Testing GET request to', testUrl);
      
      // Test GET first (like browser)
      const getResponse = await fetchWithTimeout(`${testUrl}/`, { method: 'GET' });
    
      if (!getResponse.ok) {
        const error = `GET request failed with status ${getResponse.status}`;
        console.log('[CONNECTION TEST] ❌', error, 'on', testUrl);
        lastError = { error, details: `GET / returned ${getResponse.status} on ${testUrl}` };
        continue; // Try next URL
      }
    
      const getText = await getResponse.text();
      console.log('[CONNECTION TEST] ✅ GET successful on', testUrl, ':', getText.substring(0, 50));
      
      // Test POST to /tts endpoint (like Daily Pep) using the working URL
      console.log('[CONNECTION TEST] Testing POST request to', `${testUrl}/tts`);
      try {
        const postResponse = await fetchWithTimeout(`${testUrl}/tts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: 'Test',
            voice: 'alloy',
          }),
        });
        
        console.log('[CONNECTION TEST] POST response status:', postResponse.status);
        
        if (postResponse.ok) {
          console.log('[CONNECTION TEST] ✅ POST successful on', testUrl);
          return { success: true, details: 'Both GET and POST requests work', workingUrl: testUrl };
        } else {
          const errorData = await postResponse.json().catch(() => ({}));
          const error = `POST request failed: ${postResponse.status} - ${errorData.error || 'Unknown error'}`;
          console.log('[CONNECTION TEST] ❌', error, 'on', testUrl);
          return { 
            success: false, 
            error: `POST requests failing: ${error}`,
            details: `GET works but POST /tts returned ${postResponse.status} on ${testUrl}`,
            workingUrl: testUrl
          };
        }
      } catch (postError: any) {
        const postErrorMsg = postError?.message || 'Unknown POST error';
        console.log('[CONNECTION TEST] ❌ POST failed on', testUrl, ':', postErrorMsg);
        return { 
          success: false, 
          error: `GET works but POST fails: ${postErrorMsg}`,
          details: `This suggests a CORS or network security issue with POST requests on ${testUrl}`,
          workingUrl: testUrl
        };
      }
    } catch (err: any) {
      const errorMsg = err?.message || 'Unknown error';
      console.log('[CONNECTION TEST] ❌ Connection failed on', testUrl, ':', errorMsg);
      lastError = err;
      // Continue to try next URL
      continue;
    }
  }
  
  // If we get here, all URLs failed
  const errorMsg = lastError?.message || 'Unknown error';
  console.log('[CONNECTION TEST] ❌ All URLs failed. Last error:', errorMsg);
  
  const usedEmulatorDefault = API_URL.includes('10.0.2.2');
  const physicalPhoneHint = usedEmulatorDefault
    ? [
        '► On a physical phone: the app is using the emulator address (10.0.2.2), which does not work on a real device.',
        '  In apps/mobile create or edit .env with:',
        '  EXPO_PUBLIC_API_URL=http://YOUR_PC_IP:3001',
        '  (Get YOUR_PC_IP from ipconfig on your PC, Wi‑Fi IPv4.)',
        '  Then stop Expo (Ctrl+C) and run "npx expo start" again so .env is loaded.',
        '',
      ]
    : [];
  
  if (errorMsg.includes('Network request failed') || errorMsg.includes('Failed to fetch') || errorMsg.includes('Aborted')) {
    return {
      success: false,
      error: [
        'Cannot connect to API.',
        '',
        ...physicalPhoneHint,
        '1. Start the API on your PC: cd api && npm run dev',
        '2. Physical phone: set EXPO_PUBLIC_API_URL in apps/mobile/.env to your PC IP (see above), then restart Expo.',
        '3. Same Wi‑Fi: phone and PC on the same network.',
        '4. Firewall: allow port 3001.',
        '',
        `Tried: ${urlsToTry.join(', ')}.`,
      ].join('\n'),
      details: errorMsg
    };
  }
  
  return { success: false, error: errorMsg, details: JSON.stringify(lastError) };
};

// Check on component mount
checkApiUrl();

type Status = 'idle' | 'loading' | 'error' | 'ready' | 'refused';

// Daily Pep Talk - Fetched from API
type DailyPepData = {
  date: string;
  topic: string;
  quote: string;
  scriptText: string;
  audioBase64: string;
};

// Voice Profiles - user-facing labels that map to OpenAI voices
type VoiceProfileId = 'coach_m' | 'coach_f' | 'calm_m' | 'calm_f';

const VOICE_PROFILES: Record<VoiceProfileId, { label: string; openAIVoice: string; styleHint: string; descriptor: string }> = {
  coach_m: { 
    label: 'Coach (Male)', 
    openAIVoice: 'alloy', 
    styleHint: 'confident, direct coach tone',
    descriptor: 'Firm, high energy'
  },
  coach_f: { 
    label: 'Coach (Female)', 
    openAIVoice: 'nova', 
    styleHint: 'confident, direct coach tone',
    descriptor: 'Firm, focused'
  },
  calm_m: { 
    label: 'Calm (Male)', 
    openAIVoice: 'onyx', 
    styleHint: 'calm, grounded, steady',
    descriptor: 'Steady, grounded'
  },
  calm_f: { 
    label: 'Calm (Female)', 
    openAIVoice: 'sage', 
    styleHint: 'calm, grounded, steady',
    descriptor: 'Calm, clear'
  },
};

// All available voice profiles (Pro + Flow only)
const AVAILABLE_VOICE_PROFILES: VoiceProfileId[] = ['coach_m', 'coach_f', 'calm_m', 'calm_f'];

// Motivational loading quotes for custom pep generation
const LOADING_QUOTES: string[] = [
  'Future you is watching this moment.',
  'You do not have to feel ready to start.',
  'Tiny brave choices add up fast.',
  'Discomfort is the tax on doing something that matters.',
  'You have done harder things than this.',
  'Momentum beats motivation every single time.',
];

// Daily Pep Topics and Quotes (20 items)
const DAILY_PEP_ITEMS = [
  { topic: 'Momentum', quote: 'Action creates clarity.' },
  { topic: 'Discipline', quote: 'Consistency beats intensity.' },
  { topic: 'Courage', quote: 'Fear is a compass pointing to growth.' },
  { topic: 'Focus', quote: 'One thing at a time, done well.' },
  { topic: 'Resilience', quote: 'Fall seven times, stand up eight.' },
  { topic: 'Clarity', quote: 'Decide. Then act.' },
  { topic: 'Commitment', quote: 'Show up even when you don\'t want to.' },
  { topic: 'Progress', quote: 'Small steps compound into big results.' },
  { topic: 'Presence', quote: 'Where you are is where you start.' },
  { topic: 'Ownership', quote: 'Take responsibility for your results.' },
  { topic: 'Execution', quote: 'Done is better than perfect.' },
  { topic: 'Persistence', quote: 'Keep going when it gets hard.' },
  { topic: 'Intention', quote: 'Know why you\'re doing this.' },
  { topic: 'Accountability', quote: 'Your actions define you.' },
  { topic: 'Direction', quote: 'Move forward, even slowly.' },
  { topic: 'Determination', quote: 'What you want is on the other side of effort.' },
  { topic: 'Action', quote: 'Start before you\'re ready.' },
  { topic: 'Consistency', quote: 'Daily practice beats occasional perfection.' },
  { topic: 'Purpose', quote: 'Remember what you\'re building.' },
  { topic: 'Forward', quote: 'The only way out is through.' },
];

// Simple hash function for deterministic date-based selection
const hashDate = (dateString: string): number => {
  let hash = 0;
  for (let i = 0; i < dateString.length; i++) {
    const char = dateString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
};

// Get today's date in YYYY-MM-DD format
const getTodayDateString = (): string => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Get today's daily pep item deterministically
const getTodayDailyPep = () => {
  const dateString = getTodayDateString();
  const hash = hashDate(dateString);
  const index = hash % DAILY_PEP_ITEMS.length;
  return DAILY_PEP_ITEMS[index];
};

// Daily Pep Cache Keys (v2: bumped to invalidate older, shorter peps)
const DAILY_PEP_CACHE_KEYS = {
  DATE: 'dailyPepDate_v2',
  TOPIC: 'dailyPepTopic_v2',
  QUOTE: 'dailyPepQuote_v2',
  AUDIO_URI: 'dailyPepAudioUri_v2',
};

// Helper function to get today's date key
const getTodayKey = (): string => {
  return getTodayDateString();
};

// Build Daily Pep script aimed at a minimum ~30s duration when spoken.
// We keep it focused but add enough lines and pacing that TTS is
// meaningfully longer than a single short quote.
const buildDailyScriptForTts = (topic: string, quote: string): string => {
  let script = `${quote} Today's focus is ${topic.toLowerCase()}. You know what you need to do. It's action. Movement creates clarity. Start now.`;

  script +=
    ' You do not need a perfect plan. You need a single clear action you can take in the next minute. Pick the smallest step that actually moves you forward.';

  script +=
    ' For the next half minute, stay with this. Breathe once, feel your feet on the floor, and commit to that one step. When your brain argues for comfort, remind yourself that relief comes from doing, not delaying.';

  script +=
    ' You have done harder things than this before. Prove it again right now. When this pep ends, you move immediately. No scrolling, no second guessing, just the next right action.';

  // Cap overall length so TTS latency stays reasonable while still targeting ≥30s.
  if (script.length > 900) {
    script = truncateAtSentence(script, 900);
  }
  return script;
};

// Load cached daily pep data
const loadCachedDailyPep = async (): Promise<{
  date: string | null;
  topic: string | null;
  quote: string | null;
  audioUri: string | null;
}> => {
  try {
    const [date, topic, quote, audioUri] = await AsyncStorage.multiGet([
      DAILY_PEP_CACHE_KEYS.DATE,
      DAILY_PEP_CACHE_KEYS.TOPIC,
      DAILY_PEP_CACHE_KEYS.QUOTE,
      DAILY_PEP_CACHE_KEYS.AUDIO_URI,
    ]);

    return {
      date: date[1] || null,
      topic: topic[1] || null,
      quote: quote[1] || null,
      audioUri: audioUri[1] || null,
    };
  } catch (error) {
    console.error('[DAILY] Error loading cache:', error);
    return { date: null, topic: null, quote: null, audioUri: null };
  }
};

// Save cached daily pep data
const saveCachedDailyPep = async (data: {
  date: string;
  topic: string;
  quote: string;
  audioUri: string;
}): Promise<void> => {
  try {
    await AsyncStorage.multiSet([
      [DAILY_PEP_CACHE_KEYS.DATE, data.date],
      [DAILY_PEP_CACHE_KEYS.TOPIC, data.topic],
      [DAILY_PEP_CACHE_KEYS.QUOTE, data.quote],
      [DAILY_PEP_CACHE_KEYS.AUDIO_URI, data.audioUri],
    ]);
    console.log('[DAILY] Cache saved for date:', data.date);
  } catch (error) {
    console.error('[DAILY] Error saving cache:', error);
  }
};

// Clear cached daily pep data
const clearCachedDailyPep = async (): Promise<void> => {
  try {
    await AsyncStorage.multiRemove([
      DAILY_PEP_CACHE_KEYS.DATE,
      DAILY_PEP_CACHE_KEYS.TOPIC,
      DAILY_PEP_CACHE_KEYS.QUOTE,
      DAILY_PEP_CACHE_KEYS.AUDIO_URI,
    ]);
    console.log('[DAILY] Cache cleared');
  } catch (error) {
    console.error('[DAILY] Error clearing cache:', error);
  }
};

// Honesty scale mapping
const HONESTY_LEVELS = {
  1: { label: 'Easy', apiTone: 'easy' },
  2: { label: 'Steady', apiTone: 'steady' },
  3: { label: 'Direct', apiTone: 'direct' },
  4: { label: 'Blunt', apiTone: 'blunt' },
  5: { label: 'No excuses', apiTone: 'no_excuses' },
} as const;

type HonestyLevel = 1 | 2 | 3 | 4 | 5;

// Pro/Flow structured intake options
const PRO_OUTCOME_OPTIONS = ['Show up', 'Start', 'Finish', 'Stay consistent', 'Calm down'] as const;
const PRO_OBSTACLE_OPTIONS = ['Low energy', 'Anxiety', 'Overwhelm', 'Distraction', 'Doubt', 'Laziness'] as const;

type OutcomeOption = typeof PRO_OUTCOME_OPTIONS[number];
type ObstacleOption = typeof PRO_OBSTACLE_OPTIONS[number];

// Input character limits by tier (free 500, pro/flow 1500)
const FREE_MAX_CHARS = 500;
const PRO_MAX_CHARS = 1500;

// Intent options for custom pep (multi-select)
const INTENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'Motivation', label: 'Motivation' },
  { value: 'Anxiety', label: 'Anxiety' },
  { value: 'Confidence', label: 'Confidence' },
  { value: 'Focus', label: 'Focus' },
  { value: 'Discipline', label: 'Discipline' },
  { value: 'Calm', label: 'Calm' },
  { value: 'Recovery', label: 'Recovery' },
  { value: 'Social', label: 'Social (hard conversation)' },
  { value: 'Other', label: 'Other' },
];

const theme = pepTheme;

export default function HomeScreen() {
  const router = useRouter();
  const { isPro, entitlement, useCustomPep, getRemainingCustomPeps, hasUnlimitedCustomPeps, refreshDailyCounts, refreshEntitlement } = useUser();
  
  const [goalText, setGoalText] = useState('');
  const [selectedIntents, setSelectedIntents] = useState<string[]>([]);
  const [intentOther, setIntentOther] = useState('');
  const [selectedVoiceProfileId, setSelectedVoiceProfileId] = useState<VoiceProfileId>('coach_m');
  const [honestyLevel, setHonestyLevel] = useState<HonestyLevel>(3); // Default to Direct
  const [status, setStatus] = useState<Status>('idle');
  const [loadingPhase, setLoadingPhase] = useState<'writing' | 'voicing' | null>(null);
  const [loadingQuoteIndex, setLoadingQuoteIndex] = useState(0);
  const [showAlmostReady, setShowAlmostReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentScriptText, setCurrentScriptText] = useState<string>('');
  const [currentVoiceProfileId, setCurrentVoiceProfileId] = useState<VoiceProfileId | null>(null);
  const [showCustomPep, setShowCustomPep] = useState(false);
  const [savedCustomId, setSavedCustomId] = useState<string | null>(null);
  const [savedDailyId, setSavedDailyId] = useState<string | null>(null);
  const [isRefreshingSubscription, setIsRefreshingSubscription] = useState(false);
  
  const { setCurrentSound, stopCurrent } = useAudioPlayback();
  const generationIdRef = useRef(0);
  
  // "Dial it in" expandable panel state
  const [dialItInExpanded, setDialItInExpanded] = useState(false);
  const dialItInHeight = useRef(new Animated.Value(0)).current;
  const dialItInOpacity = useRef(new Animated.Value(0)).current;
  
  // Voice preview state
  const [previewLoadingId, setPreviewLoadingId] = useState<VoiceProfileId | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewCache, setPreviewCache] = useState<Partial<Record<VoiceProfileId, string>>>({});
  
  // Helper to format length for chips (keep internal seconds)
  const formatLengthChipLabel = (seconds: number) => {
    if (seconds <= 90) return `${seconds}s`;
    if (seconds === 120) return '2m';
    if (seconds === 180) return '3m';
    const minutes = Math.round(seconds / 60);
    return `${minutes}m`;
  };

  // Helper to format duration for summary (mm:ss)
  const formatDurationSummary = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  // Estimated spoken duration from word count (~150 WPM)
  const estimatedSecondsFromWordCount = (wordCount: number) => Math.round((wordCount / 150) * 60);

  // Loading quote + status rotation while custom pep is generating
  useEffect(() => {
    if (status !== 'loading') {
      setShowAlmostReady(false);
      return;
    }
    // Rotate quotes every few seconds
    const quoteTimer = setInterval(() => {
      setLoadingQuoteIndex(prev => (prev + 1) % LOADING_QUOTES.length);
    }, 5000);

    // When we're in the voicing phase for a bit, shift copy to "Almost ready..."
    let almostTimer: ReturnType<typeof setTimeout> | null = null;
    if (loadingPhase === 'voicing') {
      almostTimer = setTimeout(() => {
        setShowAlmostReady(true);
      }, 6000);
    } else {
      setShowAlmostReady(false);
    }

    return () => {
      clearInterval(quoteTimer);
      if (almostTimer) clearTimeout(almostTimer);
    };
  }, [status, loadingPhase]);

  // Helper to generate summary text for collapsed "Dial it in"
  const getDialItInSummary = () => {
    const honestyLabel = HONESTY_LEVELS[honestyLevel].label;
    const voiceLabel = !isFreeTier ? VOICE_PROFILES[selectedVoiceProfileId].label.split(' ')[0] : '';
    const durationLabel = formatDurationSummary(targetSeconds);
    
    if (isFreeTier) {
      return `${honestyLabel} · ${durationLabel}`;
    }
    return `${honestyLabel} · ${voiceLabel} · ${durationLabel}`;
  };
  
  // Shared audio playback state
  const soundRef = useRef<Audio.Sound | null>(null);
  const [nowPlaying, setNowPlaying] = useState<'daily' | 'custom' | 'library' | 'preview' | null>(null);
  const [nowPlayingId, setNowPlayingId] = useState<string | null>(null);
  // Chunked TTS: segment URIs and pause between segments (custom pep only)
  const [segmentFileUris, setSegmentFileUris] = useState<string[] | null>(null);
  const [segmentPauseMs, setSegmentPauseMs] = useState(450);
  const [segmentPauseDurations, setSegmentPauseDurations] = useState<number[] | null>(null);
  const chunkedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentFileUrisRef = useRef<string[] | null>(null);
  const segmentPauseMsRef = useRef(450);
  const segmentPauseDurationsRef = useRef<number[] | null>(null);
  const currentChunkIndexRef = useRef(0);
  const nextChunkIndexRef = useRef<number | null>(null);
  const lastPlayTappedAtRef = useRef<number>(0);
  const dailyLoadInProgressRef = useRef(false);
  const dailyPreloadStartedRef = useRef(false);
  const userTappedDailyDuringPreloadRef = useRef(false);
  const streamDoneRef = useRef(false);
  const lastCustomCacheKeyRef = useRef<string>('');
  const lastCustomCachedResultRef = useRef<{
    fileUri: string;
    scriptText: string;
    segmentFileUris: string[] | null;
    segmentPauseMs: number;
    segmentPauseDurations: number[] | null;
  } | null>(null);
  
  // Daily Pep state
  const [dailyTopic, setDailyTopic] = useState<string | null>(null);
  const [dailyQuote, setDailyQuote] = useState<string | null>(null);
  const [dailyAudioUri, setDailyAudioUri] = useState<string | null>(null);
  const [dailyScriptText, setDailyScriptText] = useState<string>('');
  const [dailyIsLoading, setDailyIsLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyDebug, setDailyDebug] = useState<string>('');
  const [apiBaseUrl, setApiBaseUrl] = useState(API_URL);
  const lastConnectionSuccessAtRef = useRef<number>(0);
  const lastPreconnectAtRef = useRef<number>(0);
  const CONNECTION_CACHE_MS = 300000; // 5 min: skip connection test if recently OK (faster generate)
  const PRECONNECT_THROTTLE_MS = 30000; // 30s between preconnects

  // Load saved API URL on mount (so you can set it in-app without .env)
  useEffect(() => {
    AsyncStorage.getItem('PEP_API_URL').then((saved) => {
      if (saved && typeof saved === 'string' && saved.trim()) {
        const url = saved.trim().replace(/\/$/, '');
        setApiBaseUrl(url);
      }
    }).catch(() => {});
  }, []);
  
  // Reading Mode state
  const [showReadingMode, setShowReadingMode] = useState(false);
  const [readingModeScript, setReadingModeScript] = useState<string>('');
  const [readingModeTitle, setReadingModeTitle] = useState<string>('');
  
  // Pro/Flow structured intake state
  const [selectedOutcome, setSelectedOutcome] = useState<OutcomeOption | 'other' | 'skip' | null>(null);
  const [selectedObstacle, setSelectedObstacle] = useState<ObstacleOption | 'other' | 'skip' | null>(null);
  const [outcomeOther, setOutcomeOther] = useState<string>('');
  const [obstacleOther, setObstacleOther] = useState<string>('');
  const [showOutcomeOther, setShowOutcomeOther] = useState(false);
  const [showObstacleOther, setShowObstacleOther] = useState(false);
  
  // Length selector state
  const getDefaultLength = () => {
    if (entitlement === 'flow') return 90;
    if (entitlement === 'pro') return 60;
    return 30; // free
  };
  const [targetSeconds, setTargetSeconds] = useState<number>(getDefaultLength());
  
  // Update default length when entitlement changes
  useEffect(() => {
    const defaultLength = getDefaultLength();
    // Only update if current selection exceeds new tier's max
    const maxLength = entitlement === 'flow' ? 180 : entitlement === 'pro' ? 90 : 30;
    if (targetSeconds > maxLength) {
      setTargetSeconds(defaultLength);
    }
  }, [entitlement, targetSeconds]);
  
  // Flow conversion prompt state
  const [showFlowPrompt, setShowFlowPrompt] = useState(false);
  const [flowPromptMessage, setFlowPromptMessage] = useState<string>('');
  const [replayCount, setReplayCount] = useState(0);
  const [pepStartCount, setPepStartCount] = useState(0);
  const lastPlayedUriRef = useRef<string | null>(null);
  const [habitMetrics, setHabitMetrics] = useState<HabitMetrics | null>(null);
  const previousStreakRef = useRef<number | null>(null);
  const streakScaleAnim = useRef(new Animated.Value(1)).current;
  const [userPepProfileSummary, setUserPepProfileSummary] = useState<UserPepProfileSummary | null>(null);
  const [lastGeneratedRequestedSeconds, setLastGeneratedRequestedSeconds] = useState<number | null>(null);
  const [lastGeneratedWordCount, setLastGeneratedWordCount] = useState<number | null>(null);

  // Flow Continue Session: show Replay/Save/Continue after playback finishes; track session for Library
  const [customPepPlaybackFinished, setCustomPepPlaybackFinished] = useState(false);
  const [flowSessionId, setFlowSessionId] = useState<string | null>(null);
  const [flowSessionPartIndex, setFlowSessionPartIndex] = useState(0);
  const generateSessionId = () => `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const hasHandledContinueFromLibraryRef = useRef(false);

  // Feedback modal after pep finishes (disabled for production – kept for future use)
  // const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  // const [feedbackPepId, setFeedbackPepId] = useState<string | null>(null);
  // const [feedbackPepKind, setFeedbackPepKind] = useState<'daily' | 'custom'>('daily');
  // const [feedbackStep, setFeedbackStep] = useState<'main' | 'reason'>('main');
  // const [feedbackText, setFeedbackText] = useState('');
  // const [skipFeedbackAfterPep, setSkipFeedbackAfterPepState] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const customPepRef = useRef<View>(null);
  const textInputRef = useRef<TextInput>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateYAnim = useRef(new Animated.Value(10)).current;
  const dailyPepFadeAnim = useRef(new Animated.Value(0)).current;
  const dailyPepTranslateYAnim = useRef(new Animated.Value(8)).current;

  const textColor = useThemeColor({}, 'text');
  const backgroundColor = useThemeColor({}, 'background');
  const tintColor = useThemeColor({}, 'tint');

  // Load "don't ask feedback after every pep" preference (feedback modal disabled in production)
  // useEffect(() => {
  //   getSkipFeedbackAfterPep().then(setSkipFeedbackAfterPepState);
  // }, []);

  // Load saved voice profile preference on mount and when entitlement changes
  useEffect(() => {
    const loadVoicePreference = async () => {
      try {
        if (entitlement === 'free') {
          // Free users don't have voice selection
          return;
        }
        
        const savedProfileId = await AsyncStorage.getItem('selectedVoiceProfileId');
        
        if (savedProfileId && AVAILABLE_VOICE_PROFILES.includes(savedProfileId as VoiceProfileId)) {
          // Use saved profile if it's valid
          setSelectedVoiceProfileId(savedProfileId as VoiceProfileId);
        } else {
          // Reset to default profile if saved profile is invalid
          const defaultProfileId: VoiceProfileId = 'coach_m';
          setSelectedVoiceProfileId(defaultProfileId);
          await AsyncStorage.setItem('selectedVoiceProfileId', defaultProfileId);
        }
      } catch (error) {
        console.error('Error loading voice profile preference:', error);
      }
    };
    loadVoicePreference();
  }, [entitlement]);

  // Load habit metrics on mount (streak, daily pep played today)
  useEffect(() => {
    loadHabitMetrics().then(setHabitMetrics).catch(() => setHabitMetrics(null));
  }, []);

  // When streak increases, run a one-time scale animation (1 -> 1.15 -> 1.0)
  useEffect(() => {
    const current = habitMetrics?.streakCount ?? 0;
    const prev = previousStreakRef.current;
    previousStreakRef.current = current;
    if (prev !== null && current > prev) {
      streakScaleAnim.setValue(1);
      Animated.sequence([
        Animated.timing(streakScaleAnim, {
          toValue: 1.15,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(streakScaleAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [habitMetrics?.streakCount, streakScaleAnim]);

  // Load default honesty level from feedback-adjusted default
  useEffect(() => {
    getDefaultHonestyLevel().then((level) => setHonestyLevel(level as HonestyLevel));
  }, []);

  // Load default length from Settings (if set)
  useEffect(() => {
    AsyncStorage.getItem('defaultTargetSeconds').then((s) => {
      if (!s) return;
      const n = parseInt(s, 10);
      const max = entitlement === 'flow' ? 300 : entitlement === 'pro' ? 90 : 30;
      if (!Number.isNaN(n) && n >= 30 && n <= max) setTargetSeconds(n);
    });
  }, [entitlement]);

  // Load Flow user profile summary for "Built for" line
  useEffect(() => {
    if (entitlement === 'flow') {
      getUserPepProfileSummary().then(setUserPepProfileSummary).catch(() => setUserPepProfileSummary(null));
    } else {
      setUserPepProfileSummary(null);
    }
  }, [entitlement]);

  // Safety: if we stay in loading state too long, force-clear so UI never stays stuck.
  // Keep this slightly above API_REQUEST_TIMEOUT_MS so we gracefully surface a timeout to the user.
  const LOADING_GUARD_MS = 110000;
  useEffect(() => {
    if (status !== 'loading' && !dailyIsLoading) return;
    const guard = setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'error' : s));
      setDailyIsLoading(false);
      setErrorMessage('Request took too long. Please try again.');
      setTimeout(() => Alert.alert('Request timed out', 'Something took too long. Please try again.'), 0);
    }, LOADING_GUARD_MS);
    return () => clearTimeout(guard);
  }, [status, dailyIsLoading]);

  // Save voice profile preference when changed
  const handleVoiceProfileChange = (profileId: VoiceProfileId) => {
    if (!(status === 'loading' || dailyIsLoading)) {
      setSelectedVoiceProfileId(profileId);
      AsyncStorage.setItem('selectedVoiceProfileId', profileId).catch(console.error);
    }
  };

  // Preview voice profile
  const handleVoicePreview = async (profileId: VoiceProfileId) => {
    // Check for localhost API_URL (dev only)
    if (apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')) {
      setPreviewError('Preview unavailable: API URL is localhost. Use your LAN IP for device testing.');
      console.log('[PREVIEW] localhost detected, skipping preview');
      return;
    }

    // If we already have a cached preview for this voice, play it immediately
    const cachedUri = previewCache[profileId];
    if (cachedUri) {
      console.log('[PREVIEW] using cached audio for', profileId);
      setPreviewLoadingId(profileId);
      setPreviewError(null);
      try {
        await stopPlayback();
        await playFromUri(cachedUri, 'preview', profileId);
      } catch (err) {
        console.log('[PREVIEW] cached play error', err);
        setPreviewError('Unable to play preview');
      } finally {
        setPreviewLoadingId(null);
      }
      return;
    }

    setPreviewLoadingId(profileId);
    setPreviewError(null);
    
    try {
      console.log('[PREVIEW] start', profileId);
      
      // Stop any main audio playback (playFromUri will handle this, but we do it explicitly)
      await stopPlayback();
      
      const profile = VOICE_PROFILES[profileId];
      const previewText = "You don't need motivation. You need momentum. Now move.";
      
      // Call TTS endpoint for preview
      const response = await fetch(`${apiBaseUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: previewText,
          voice: profile.openAIVoice,
        }),
      });
      
      console.log('[PREVIEW] response status', response.status);
      
      const data = await response.json();
      
      if (!response.ok) {
        const errText = data?.error || 'Preview failed';
        setPreviewError(errText);
        console.log('[PREVIEW] error', errText);
        return;
      }
      
      const { audioBase64 } = data;
      console.log('[PREVIEW] got audioBase64?', Boolean(audioBase64));
      
      if (!audioBase64) {
        const errText = 'No audio data received';
        setPreviewError(errText);
        console.log('[PREVIEW] error', errText);
        return;
      }
      
      // Decode base64 and write to temporary file
      const fs = FileSystem as any;
      let cacheDir: string | null = null;
      
      try {
        const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
        if (cacheDirectory) {
          cacheDir = cacheDirectory.uri || String(cacheDirectory);
        }
      } catch (e) {
        // Ignore, will use legacy API
      }
      
      if (!cacheDir) {
        cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
      }
      
      if (!cacheDir) {
        if (Platform.OS === 'web') {
          // Use data URI for web
          const dataUri = `data:audio/mpeg;base64,${audioBase64}`;
          console.log('[PREVIEW] wrote uri (web)', dataUri.substring(0, 50) + '...');
          await playFromUri(dataUri, 'preview', profileId);
          return;
        }
        const errText = 'File system not available';
        setPreviewError(errText);
        console.log('[PREVIEW] error', errText);
        return;
      }
      
      if (!cacheDir.endsWith('/')) {
        cacheDir += '/';
      }
      
      const fileUri = `${cacheDir}voice_preview_${Date.now()}.mp3`;
      
      try {
        await FileSystemLegacy.writeAsStringAsync(fileUri, audioBase64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        console.log('[PREVIEW] wrote uri', fileUri);
        // Cache this preview so subsequent plays are instant
        setPreviewCache((prev) => ({ ...prev, [profileId]: fileUri }));
      } catch (writeErr) {
        const errText = 'Failed to write preview file';
        setPreviewError(errText);
        console.log('[PREVIEW] error', errText, writeErr);
        return;
      }
      
      // Use playFromUri to play the preview (it handles stopping previous audio)
      await playFromUri(fileUri, 'preview', profileId);
    } catch (err) {
      let errText = 'Preview failed';
      if (err instanceof Error) {
        // Expand common network errors into a more helpful message
        if (
          err.message.includes('Network request failed') ||
          err.message.includes('Failed to fetch')
        ) {
          errText =
            `Cannot connect to API at ${apiBaseUrl}. ` +
            'Make sure the API server is running, your device is on the same Wi‑Fi, ' +
            'and Windows Firewall allows port 3001.';
        } else {
          errText = err.message;
        }
      }
      setPreviewError(errText);
      console.error('[PREVIEW] error', errText, err);
    } finally {
      setPreviewLoadingId(null);
    }
  };

  // Refresh counts on mount and when returning to screen
  useEffect(() => {
    refreshDailyCounts();
  }, []);

  // Refresh entitlement when Home gains focus; preconnect to API so first Generate is faster
  useFocusEffect(
    useCallback(() => {
      refreshEntitlement();
      // Warm connection to API so first custom pep request doesn't pay full TCP+TLS time
      if (apiBaseUrl && !apiBaseUrl.includes('localhost') && !apiBaseUrl.includes('127.0.0.1') && Date.now() - lastPreconnectAtRef.current > PRECONNECT_THROTTLE_MS) {
        lastPreconnectAtRef.current = Date.now();
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        fetch(`${apiBaseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal })
          .then(() => { lastConnectionSuccessAtRef.current = Date.now(); })
          .catch(() => {})
          .finally(() => { clearTimeout(t); });
      }
    }, [refreshEntitlement, apiBaseUrl])
  );

  // Animate Custom Pep section when revealed
  useEffect(() => {
    if (showCustomPep) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(translateYAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
      
      // Scroll to Custom Pep section after a short delay
      setTimeout(() => {
        if (customPepRef.current && scrollViewRef.current) {
          customPepRef.current.measureLayout(
            scrollViewRef.current as any,
            (x, y) => {
              scrollViewRef.current?.scrollTo({ y: y - 20, animated: true });
            },
            () => {}
          );
        }
      }, 200);
    } else {
      fadeAnim.setValue(0);
      translateYAnim.setValue(10);
    }
  }, [showCustomPep]);

  // Animate "Dial it in" panel expand/collapse
  useEffect(() => {
    Animated.parallel([
      Animated.timing(dialItInHeight, {
        toValue: dialItInExpanded ? 1 : 0,
        duration: 240,
        useNativeDriver: false,
      }),
      Animated.timing(dialItInOpacity, {
        toValue: dialItInExpanded ? 1 : 0,
        duration: 200,
        useNativeDriver: false,
      }),
    ]).start();
  }, [dialItInExpanded]);

  // Load cached daily pep on mount (guarded so startup never crashes)
  useEffect(() => {
    const loadCache = async () => {
      try {
        const today = getTodayKey();
        const cached = await loadCachedDailyPep();

        if (cached.date === today && cached.audioUri) {
          // Cache hit - verify file exists
          console.log('[DAILY] cache hit (date:', cached.date, ')');
          try {
            const fileInfo = await FileSystemLegacy.getInfoAsync(cached.audioUri);
            if (fileInfo?.exists) {
              setDailyTopic(cached.topic);
              setDailyQuote(cached.quote);
              setDailyAudioUri(cached.audioUri);
              console.log('[DAILY] Using cached daily pep');
            } else {
              console.log('[DAILY] cached file missing -> regenerate');
              await clearCachedDailyPep();
              const todayPep = getTodayDailyPep();
              setDailyTopic(todayPep.topic);
              setDailyQuote(todayPep.quote);
            }
          } catch (fileErr) {
            console.warn('[DAILY] Error checking file:', fileErr);
            await clearCachedDailyPep();
            const todayPep = getTodayDailyPep();
            setDailyTopic(todayPep.topic);
            setDailyQuote(todayPep.quote);
          }
        } else {
          console.log('[DAILY] cache miss (date:', cached.date || 'none', ')');
          const todayPep = getTodayDailyPep();
          setDailyTopic(todayPep.topic);
          setDailyQuote(todayPep.quote);
          if (cached.date && cached.date !== today) {
            await clearCachedDailyPep();
          }
        }
      } catch (err) {
        console.warn('[DAILY] Cache load failed, using fallback:', err);
        const todayPep = getTodayDailyPep();
        setDailyTopic(todayPep.topic);
        setDailyQuote(todayPep.quote);
      }
    };

    loadCache().catch((err) => console.warn('[DAILY] loadCache promise rejected:', err));
  }, []);

  // Background preload daily pep for all users when no cache for today so first tap is
  // instant whenever possible. This kicks off as soon as we know today's topic/quote,
  // right after app open.
  useEffect(() => {
    if (!dailyTopic || !dailyQuote || dailyAudioUri) return;
    if (dailyPreloadStartedRef.current) return;
    if (apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')) return;

    dailyPreloadStartedRef.current = true;
    const timeoutId = setTimeout(async () => {
      dailyLoadInProgressRef.current = true;
      const todayPep = getTodayDailyPep();
      const topic = todayPep.topic;
      const quote = todayPep.quote;
      const dailyScript = buildDailyScriptForTts(topic, quote);
      try {
        const connectionTest = await testApiConnection(apiBaseUrl);
        if (!connectionTest.success) {
          dailyLoadInProgressRef.current = false;
          return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
        const dailyVoiceProfileId: VoiceProfileId = selectedVoiceProfileId ?? 'coach_m';
const dailyOpenAIVoice = VOICE_PROFILES[dailyVoiceProfileId].openAIVoice;

const response = await fetch(`${apiBaseUrl}/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: dailyScript, voice: dailyOpenAIVoice, singleVoice: true }),
  signal: controller.signal,
}).finally(() => clearTimeout(timeout));
        if (!response.ok) {
          dailyLoadInProgressRef.current = false;
          return;
        }
        const data = await response.json();
        const { audioBase64 } = data;
        if (!audioBase64) {
          dailyLoadInProgressRef.current = false;
          return;
        }
        const fs = FileSystem as any;
        let cacheDir: string | null = null;
        try {
          const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
          cacheDir = cacheDirectory?.uri ?? String(cacheDirectory ?? '');
        } catch {
          // ignore
        }
        if (!cacheDir) {
          cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
        }
        if (!cacheDir || Platform.OS === 'web') {
          dailyLoadInProgressRef.current = false;
          return;
        }
        if (!cacheDir.endsWith('/')) cacheDir += '/';
        const fileUri = `${cacheDir}daily_${Date.now()}.mp3`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, audioBase64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        const today = getTodayKey();
        await saveCachedDailyPep({ date: today, topic, quote, audioUri: fileUri });
        await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);
        setDailyScriptText(dailyScript);
        setDailyAudioUri(fileUri);
        if (userTappedDailyDuringPreloadRef.current) {
          userTappedDailyDuringPreloadRef.current = false;
          setDailyIsLoading(false);
          playFromUri(fileUri, 'daily').catch(() => {});
        }
      } catch {
        // Preload failed; user can tap to retry
      } finally {
        dailyLoadInProgressRef.current = false;
      }
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [dailyTopic, dailyQuote, dailyAudioUri, entitlement, apiBaseUrl]);

  // Animate Daily Pep content when it loads
  useEffect(() => {
    if (dailyTopic && dailyQuote) {
      Animated.parallel([
        Animated.timing(dailyPepFadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(dailyPepTranslateYAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      dailyPepFadeAnim.setValue(0);
      dailyPepTranslateYAnim.setValue(8);
    }
  }, [dailyTopic, dailyQuote]);

  // When daily content changes (e.g. new day), clear saved state so we don't show "Saved" for previous day
  useEffect(() => {
    setSavedDailyId(null);
  }, [dailyAudioUri, dailyTopic]);

  // Cleanup sound on unmount
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(console.error);
      }
    };
  }, []);

  // Set audio mode once on mount so playback uses speaker and is audible (not earpiece)
  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      playThroughEarpieceAndroid: false,
      shouldDuckAndroid: true,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    }).catch((e) => console.warn('[AUDIO] setAudioModeAsync failed:', e));
  }, []);

  const toneToHonestyLevel = (tone: string | number): HonestyLevel => {
    if (typeof tone === 'number') {
      if (tone < 1) return 1;
      if (tone > 5) return 5;
      return tone as HonestyLevel;
    }
    switch (tone) {
      case 'easy':
        return 1;
      case 'steady':
        return 2;
      case 'direct':
        return 3;
      case 'blunt':
        return 4;
      case 'no_excuses':
        return 5;
      default:
        return 3;
    }
  };

  // Continuation tone: one step more intense (keeps tone consistent but progresses)
  const getContinuationTone = (tone: 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses'): 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses' => {
    const order: ('easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses')[] = ['easy', 'steady', 'direct', 'blunt', 'no_excuses'];
    const i = order.indexOf(tone);
    return i < order.length - 1 ? order[i + 1] : tone;
  };

  // Shared function to generate pep talk and TTS audio (legacy single-step path, still used for Daily/Flow)
  const generatePepTalk = async (
    userText: string,
    tier: 'free' | 'pro' | 'flow',
    tone: 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses',
    voiceProfileId: VoiceProfileId | null = null,
    outcome: string | null = null,
    obstacle: string | null = null,
    intents: string[] = [],
    intentOther: string | null = null,
    profileSummary: string | null = null,
    overrideTargetSeconds?: number,
    onPhase?: (phase: 'writing' | 'voicing') => void,
    previousScriptSummary?: string | null,
    isContinuation?: boolean
  ): Promise<{ scriptText: string; fileUri: string | null; wordCount?: number; segmentFileUris?: string[]; segmentPauseMs?: number; segmentPauseDurations?: number[] }> => {
    onPhase?.('writing');
    const body: Record<string, unknown> = {
      userText: userText.trim(),
      tier: tier,
      tone: tone,
      targetSeconds: Number(overrideTargetSeconds ?? targetSeconds),
      voiceProfileId: voiceProfileId,
      singleVoice: true, // entire pep must use one voice (no mid-talk voice change)
      outcome: outcome,
      obstacle: obstacle,
      intents: Array.isArray(intents) ? intents : [],
      intentOther: intentOther && intentOther.trim() ? intentOther.trim() : null,
    };
    if (profileSummary != null && profileSummary.trim()) {
      body.profileSummary = profileSummary.trim();
    }
    if (previousScriptSummary != null && previousScriptSummary.trim()) {
      body.previousScriptSummary = previousScriptSummary.trim();
    }
    if (isContinuation === true) {
      body.isContinuation = true;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/pep`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      const err = fetchError as Error;
      if (err?.name === 'AbortError') {
        throw new Error('Taking longer than usual. Please try again.');
      }
      const msg = err?.message ?? '';
      if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
        throw new Error('No connection. Check your network and try again.');
      }
      console.error('[PEP] Fetch error:', msg);
      throw new Error(msg || 'Request failed. Please try again.');
    }
    clearTimeout(timeoutId);
    if (!response.ok) {
      let serverMsg = '';
      try {
        const text = await response.text();
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          serverMsg = json?.error ?? json?.message ?? text.slice(0, 120);
        } catch {
          serverMsg = text.slice(0, 120);
        }
      } catch (_) {}
      const fallback = `Server error (${response.status}). Please try again.`;
      throw new Error(serverMsg?.trim() ? `${serverMsg.trim()}` : fallback);
    }
    let data: Record<string, unknown>;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch (parseErr) {
      console.error('[PEP] Response JSON parse failed:', parseErr);
      throw new Error('Invalid response from server. Please try again.');
    }
    console.log('[PEP] Response data keys:', Object.keys(data));
    const scriptText = data.scriptText as string | undefined;
    const audioBase64 = data.audioBase64 as string | undefined;
    const audioSegments = data.audioSegments as string[] | undefined;
    const apiSegmentPauseMs = data.segmentPauseMs as number | undefined;
    const apiSegmentPauseDurations = data.segmentPauseDurations as number[] | undefined;
    const responseWordCount = data.wordCount as number | undefined;

    console.log('[PEP] Got scriptText?', Boolean(scriptText), scriptText ? `length: ${scriptText.length}` : '');
    console.log('[PEP] Got audioBase64?', Boolean(audioBase64), audioBase64 ? `length: ${audioBase64.length}` : '');
    console.log('[PEP] Got audioSegments?', Boolean(audioSegments?.length), audioSegments?.length ?? 0);

    if (!scriptText) {
      throw new Error('No script text received');
    }

    onPhase?.('voicing');

    // If audioBase64 is null (refused request), return null fileUri
    if (!audioBase64) {
      console.log('[PEP] No audioBase64 - returning null fileUri');
      return { scriptText, fileUri: null, wordCount: undefined };
    }

    // Decode base64 and write to cache file
    const fs = FileSystem as any;
    let cacheDir: string | null = null;
    
    try {
      // Try new Paths API first
      const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
      if (cacheDirectory) {
        cacheDir = cacheDirectory.uri || String(cacheDirectory);
      }
    } catch (e) {
      // Ignore, will use legacy API
    }
    
    // Fallback to legacy API for directory path
    if (!cacheDir) {
      cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
    }
    
    if (!cacheDir) {
      // If on web, use data URI instead
      if (Platform.OS === 'web') {
        return { scriptText, fileUri: `data:audio/mpeg;base64,${audioBase64}`, wordCount: typeof responseWordCount === 'number' ? responseWordCount : undefined };
      }
      throw new Error(
        'File system not available. ' +
        'Make sure you are running on a physical device or emulator (not web). ' +
        'If using Expo Go, try: 1) Restart the app, 2) Clear cache, 3) Reinstall Expo Go.'
      );
    }
    
    // Ensure cacheDir ends with /
    if (!cacheDir.endsWith('/')) {
      cacheDir += '/';
    }
    
    const prefix = `pep_${Date.now()}`;
    const fileUri = `${cacheDir}${prefix}.mp3`;

    try {
      await FileSystemLegacy.writeAsStringAsync(fileUri, audioBase64, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      console.log('[PEP] ✅ Full audio file written:', fileUri);
    } catch (writeError) {
      console.error('[PEP] ❌ Error writing audio file:', writeError);
      throw new Error(`Failed to write audio file: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`);
    }

    let segmentFileUris: string[] | undefined;
    let segmentPauseDurations: number[] | undefined;
    const segmentPauseMs = typeof apiSegmentPauseMs === 'number' ? apiSegmentPauseMs : 450;
    if (audioSegments?.length) {
      const segUris: string[] = [];
      for (let i = 0; i < audioSegments.length; i++) {
        const segUri = `${cacheDir}${prefix}_seg${i}.mp3`;
        await FileSystemLegacy.writeAsStringAsync(segUri, audioSegments[i], {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        segUris.push(segUri);
      }
      segmentFileUris = segUris;
      if (Array.isArray(apiSegmentPauseDurations) && apiSegmentPauseDurations.length === audioSegments.length) {
        segmentPauseDurations = apiSegmentPauseDurations;
      }
      console.log('[PEP] ✅ Segment files written:', segUris.length, segmentPauseDurations ? '(with cue-derived pauses)' : '');
    }

    await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);

    return {
      scriptText,
      fileUri,
      ...(typeof responseWordCount === 'number' ? { wordCount: responseWordCount } : {}),
      ...(segmentFileUris?.length
        ? { segmentFileUris, segmentPauseMs, ...(segmentPauseDurations ? { segmentPauseDurations } : {}) }
        : {}),
    };
  };

  // Step 1: script-only generation for custom pep
  const generatePepScriptOnly = async (
    userText: string,
    tier: 'free' | 'pro' | 'flow',
    tone: 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses',
    voiceProfileId: VoiceProfileId | null,
    outcome: string | null,
    obstacle: string | null,
    intents: string[],
    intentOther: string | null,
    overrideTargetSeconds?: number,
    onPhase?: (phase: 'writing' | 'voicing') => void
  ): Promise<{ requestId: string; scriptText: string; wordCount?: number; estDurationSec?: number }> => {
    onPhase?.('writing');
    const body: Record<string, unknown> = {
      userText: userText.trim(),
      tier,
      tone,
      targetSeconds: Number(overrideTargetSeconds ?? targetSeconds),
      voiceProfileId,
      outcome,
      obstacle,
      intents: Array.isArray(intents) ? intents : [],
      intentOther: intentOther && intentOther.trim() ? intentOther.trim() : null,
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/pep-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      const err = fetchError as Error;
      if (err?.name === 'AbortError') {
        throw new Error('Taking longer than usual. Please try again.');
      }
      const msg = err?.message ?? '';
      if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
        throw new Error('No connection. Check your network and try again.');
      }
      console.error('[PEP] /pep-script fetch error:', msg);
      throw new Error(msg || 'Request failed. Please try again.');
    }
    clearTimeout(timeoutId);
    if (!response.ok) {
      let serverMsg = '';
      try {
        const text = await response.text();
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          serverMsg = json?.error ?? json?.message ?? text.slice(0, 120);
        } catch {
          serverMsg = text.slice(0, 120);
        }
      } catch {}
      const fallback = `Server error (${response.status}). Please try again.`;
      throw new Error(serverMsg?.trim() ? `${serverMsg.trim()}` : fallback);
    }
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch (parseErr) {
      console.error('[PEP] /pep-script JSON parse failed:', parseErr);
      throw new Error('Invalid response from server. Please try again.');
    }
    const requestId = data.requestId as string | undefined;
    const scriptText = data.scriptText as string | undefined;
    const meta = data.meta as { wordCount?: number; estDurationSec?: number } | undefined;
    if (!requestId || !scriptText) {
      throw new Error('Invalid script response from server.');
    }
    return { requestId, scriptText, wordCount: meta?.wordCount, estDurationSec: meta?.estDurationSec };
  };

  // Step 2: audio-only generation for custom pep (given script from step 1)
  const generatePepAudioOnly = async (
    requestId: string,
    scriptText: string,
    tier: 'free' | 'pro' | 'flow',
    tone: 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses',
    voiceProfileId: VoiceProfileId | null,
    overrideTargetSeconds?: number,
    onPhase?: (phase: 'writing' | 'voicing') => void
  ): Promise<{ fileUri: string; segmentFileUris?: string[]; segmentPauseMs?: number; segmentPauseDurations?: number[] | null }> => {
    onPhase?.('voicing');
    const body: Record<string, unknown> = {
      requestId,
      scriptText,
      tier,
      tone,
      targetSeconds: Number(overrideTargetSeconds ?? targetSeconds),
      voiceProfileId,
    };
    const controller = new AbortController();
    const isLongPep = (overrideTargetSeconds ?? targetSeconds) >= 120;
    const audioTimeoutMs = isLongPep ? 300000 : API_REQUEST_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), audioTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/pep-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      const err = fetchError as Error;
      if (err?.name === 'AbortError') {
        throw new Error('Audio is taking longer than usual. Please try again.');
      }
      const msg = err?.message ?? '';
      if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
        throw new Error('No connection. Check your network and try again.');
      }
      console.error('[PEP] /pep-audio fetch error:', msg);
      throw new Error(msg || 'Audio request failed. Please try again.');
    }
    clearTimeout(timeoutId);
    if (!response.ok) {
      let serverMsg = '';
      try {
        const text = await response.text();
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          serverMsg = json?.error ?? json?.message ?? text.slice(0, 120);
        } catch {
          serverMsg = text.slice(0, 120);
        }
      } catch {}
      const fallback = `Server error (${response.status}). Please try again.`;
      throw new Error(serverMsg?.trim() ? `${serverMsg.trim()}` : fallback);
    }
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch (parseErr) {
      console.error('[PEP] /pep-audio JSON parse failed:', parseErr);
      throw new Error('Invalid audio response from server. Please try again.');
    }
    const segmentBase64s = data.segmentBase64s as string[] | undefined;
    const segmentPauseDurations = data.segmentPauseDurations as number[] | undefined;
    const segmentPauseMsFromApi = data.segmentPauseMs as number | undefined;
    const audioUrl = data.audioUrl as string | undefined;
    const audioBase64 = data.audioBase64 as string | undefined;

    const fs = FileSystem as any;
    let cacheDir: string | null = null;
    try {
      const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
      if (cacheDirectory) cacheDir = cacheDirectory.uri || String(cacheDirectory);
    } catch {}
    if (!cacheDir) cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
    if (!cacheDir || Platform.OS === 'web') {
      throw new Error('Audio cache is not available on this platform.');
    }
    if (!cacheDir.endsWith('/')) cacheDir += '/';
    const prefix = `pep_${Date.now()}`;

    if (segmentBase64s?.length) {
      const segmentFileUris: string[] = [];
      for (let i = 0; i < segmentBase64s.length; i++) {
        const uri = `${cacheDir}${prefix}_seg${i}.mp3`;
        await FileSystemLegacy.writeAsStringAsync(uri, segmentBase64s[i], {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        segmentFileUris.push(uri);
      }
      await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);
      return {
        fileUri: segmentFileUris[0],
        segmentFileUris,
        segmentPauseMs: segmentPauseMsFromApi ?? 450,
        segmentPauseDurations: segmentPauseDurations ?? null,
      };
    }

    if (!audioUrl && !audioBase64) {
      throw new Error('No audio received from server.');
    }
    const fileUri = `${cacheDir}${prefix}.mp3`;
    if (audioUrl) {
      const downloadResult = await FileSystemLegacy.downloadAsync(audioUrl, fileUri);
      if (downloadResult.status !== 200) throw new Error(`Audio download failed: ${downloadResult.status}`);
      console.log('[PEP] Audio downloaded from URL (pep-audio)');
    } else {
      await FileSystemLegacy.writeAsStringAsync(fileUri, audioBase64!, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
    }
    await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);
    return { fileUri };
  };

  // Try streaming /pep; throws on any failure so caller can fallback to full generation
  const tryStreamingPepGeneration = async (
    tier: 'free' | 'pro' | 'flow',
    apiTone: 'easy' | 'steady' | 'direct' | 'blunt' | 'no_excuses',
    voiceProfileId: VoiceProfileId | null,
    outcomeString: string | null,
    obstacleString: string | null,
    intentsToSend: string[],
    intentOtherToSend: string | null,
    cacheKey: string,
    onPhase: (phase: 'writing' | 'voicing') => void
  ): Promise<void> => {
    onPhase('writing');
    const fs = FileSystem as any;
    let cacheDir: string | null = null;
    try {
      const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
      if (cacheDirectory) cacheDir = cacheDirectory.uri || String(cacheDirectory);
    } catch (_) {}
    if (!cacheDir) cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
    if (!cacheDir || Platform.OS === 'web') throw new Error('Streaming not available');

    if (!cacheDir.endsWith('/')) cacheDir += '/';
    const prefix = `pep_${Date.now()}`;
    segmentFileUrisRef.current = [];
    segmentPauseDurationsRef.current = [];
    streamDoneRef.current = false;

    const body = {
      userText: goalText.trim(),
      tier,
      tone: apiTone,
      targetSeconds,
      voiceProfileId,
      singleVoice: true,
      outcome: outcomeString,
      obstacle: obstacleString,
      intents: intentsToSend,
      intentOther: intentOtherToSend,
      stream: true,
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    const response = await fetch(`${apiBaseUrl}/pep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const text = await response.text();
      let msg = '';
      try {
        const j = JSON.parse(text) as { error?: string };
        msg = j?.error ?? text.slice(0, 120);
      } catch {
        msg = text.slice(0, 120);
      }
      throw new Error(msg || `Server error (${response.status})`);
    }
    const processLine = async (trimmed: string) => {
      let data: { type: string; scriptText?: string; wordCount?: number; segmentPauseMs?: number; index?: number; audioBase64?: string; pauseAfterSeconds?: number; error?: string };
      try {
        data = JSON.parse(trimmed) as typeof data;
      } catch {
        return;
      }
      if (data.type === 'script') {
        scriptText = data.scriptText ?? '';
        segmentPauseMs = typeof data.segmentPauseMs === 'number' ? data.segmentPauseMs : 450;
        setCurrentScriptText(scriptText);
        setLastGeneratedWordCount(typeof data.wordCount === 'number' ? data.wordCount : null);
        setSegmentPauseMs(segmentPauseMs);
      } else if (data.type === 'segment' && data.audioBase64 != null && typeof data.index === 'number') {
        const segUri = `${cacheDir}${prefix}_seg${data.index}.mp3`;
        await FileSystemLegacy.writeAsStringAsync(segUri, data.audioBase64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        const pauseSec = typeof data.pauseAfterSeconds === 'number' ? data.pauseAfterSeconds : 0;
        segmentFileUrisRef.current = segmentFileUrisRef.current ?? [];
        segmentFileUrisRef.current.push(segUri);
        segmentPauseDurationsRef.current = segmentPauseDurationsRef.current ?? [];
        segmentPauseDurationsRef.current.push(pauseSec);
        setSegmentFileUris(prev => [...(prev ?? []), segUri]);
        setSegmentPauseDurations(prev => [...(prev ?? []), pauseSec]);
        if (data.index === 0) {
          setStatus('ready');
          setLoadingPhase(null);
          setCurrentVoiceProfileId(voiceProfileId);
          setLastGeneratedRequestedSeconds(targetSeconds);
          if (bodyReader) {
            console.log('[PEP] First segment received — starting playback while rest stream');
            playStreamingSegments(segmentPauseMs);
          }
        }
      } else if (data.type === 'done') {
        streamDoneRef.current = true;
      } else if (data.type === 'error') {
        throw new Error(data.error ?? 'Stream error');
      }
    };

    let scriptText = '';
    let segmentPauseMs = 450;
    const bodyReader = response.body?.getReader?.();

    if (!bodyReader) {
      // React Native etc. may not support ReadableStream; consume full response as text and parse NDJSON
      console.log('[PEP] Stream API not available, parsing buffered NDJSON response');
      onPhase('voicing');
      const text = await response.text();
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await processLine(trimmed);
      }
      streamDoneRef.current = true;
    } else {
      console.log('[PEP] Streaming TTS: playback will start when first segment arrives');
      onPhase('voicing');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await bodyReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lineParts = buffer.split('\n');
        buffer = lineParts.pop() ?? '';
        for (const line of lineParts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          await processLine(trimmed);
        }
      }
      streamDoneRef.current = true;
    }

    const uris = segmentFileUrisRef.current ?? [];
    if (uris.length > 0) {
      let mergedUri = uris[0];
      if (uris.length > 1) {
        let combined = '';
        for (const uri of uris) {
          combined += await FileSystemLegacy.readAsStringAsync(uri, { encoding: FileSystemLegacy.EncodingType.Base64 });
        }
        mergedUri = `${cacheDir}${prefix}_full.mp3`;
        await FileSystemLegacy.writeAsStringAsync(mergedUri, combined, { encoding: FileSystemLegacy.EncodingType.Base64 });
      }
      setAudioUri(mergedUri);
      lastCustomCacheKeyRef.current = cacheKey;
      lastCustomCachedResultRef.current = {
        fileUri: mergedUri,
        scriptText,
        segmentFileUris: uris,
        segmentPauseMs,
        segmentPauseDurations: segmentPauseDurationsRef.current ?? null,
      };
      recordCustomPepGenerated().catch(() => {});
      recordPepProfileUsage({
        intents: intentsToSend,
        intensity: apiTone,
        voiceProfileId: voiceProfileId ?? 'coach_m',
        outcome: outcomeString,
        obstacle: obstacleString,
      }).then(() => {
        if (entitlement === 'flow') getUserPepProfileSummary().then(setUserPepProfileSummary);
      }).catch(() => {});
      await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);
      // Buffered path never called playStreamingSegments; start playback now
      if (!bodyReader && uris.length > 0) {
        try {
          if (uris.length > 1) {
            const estimatedMinutes = targetSeconds / 60;
            await playChunkedSegments(uris, segmentPauseMs, segmentPauseDurationsRef.current ?? undefined, estimatedMinutes);
          } else {
            await playFromUri(mergedUri, 'custom');
          }
          console.log('[PEP] ✅ Playback started (buffered)');
        } catch (playError) {
          console.error('[PEP] ❌ Error starting playback:', playError);
          Alert.alert('Audio Ready', 'Pep talk generated! Tap Play to listen.');
        }
      }
    }
  };

  const handleGenerate = async () => {
    if (!goalText.trim()) {
      Alert.alert('Error', 'Tell Pep what you are avoiding.');
      return;
    }

    if (goalText.trim().length > maxChars) {
      Alert.alert('Text too long', `Keep it under ${maxChars} characters.`);
      return;
    }

    // Test API connection unless we succeeded recently (faster generate)
    const skipConnectionTest = Date.now() - lastConnectionSuccessAtRef.current < CONNECTION_CACHE_MS;
    if (!skipConnectionTest) {
      console.log('[PEP] Testing API connection before generation...');
      const connectionTest = await testApiConnection(apiBaseUrl);
      if (!connectionTest.success) {
        const errorMsg = connectionTest.error || 'Cannot connect to API';
        const details = connectionTest.details ? `\n\nDetails: ${connectionTest.details}` : '';
        setErrorMessage(errorMsg + details);
        setStatus('error');
        Alert.alert(
          'Connection Error',
          errorMsg + details,
          [
            { text: 'OK' },
            {
              text: 'Test Again',
              onPress: async () => {
                const test = await testApiConnection(apiBaseUrl);
                const testDetails = test.details ? `\n\n${test.details}` : '';
                Alert.alert(
                  test.success ? 'Connection OK' : 'Connection Failed',
                  test.success ? 'API is reachable!' : ((test.error || 'Unknown error') + testDetails)
                );
              }
            }
          ]
        );
        return;
      }
      lastConnectionSuccessAtRef.current = Date.now();
    }

    // For Pro/Flow, validate "Other" text fields if selected
    if (!isFreeTier) {
      if (selectedOutcome === 'other' && !outcomeOther.trim()) {
        Alert.alert('Missing details', 'Please enter your desired outcome.');
        return;
      }
      if (selectedObstacle === 'other' && !obstacleOther.trim()) {
        Alert.alert('Missing details', 'Please enter the real obstacle.');
        return;
      }
    }

    // Track pep starts: increment when user manually starts a second pep
    setPepStartCount(prev => {
      const newCount = prev + 1;
      // Show Flow prompt when starting second pep
      if (newCount >= 2) {
        showFlowPromptIfNeeded('second_pep');
      }
      return newCount;
    });

    // Check if user can use custom pep (Daily Pep is never limited — only custom pep counts)
    const canUse = await useCustomPep();
    if (!canUse) {
      setErrorMessage(
        entitlement === 'flow'
          ? "Today's limit reached. Try again tomorrow."
          : 'Daily limit reached. Upgrade for more.'
      );
      setStatus('error');
      return;
    }

    // Immediately enter loading state so users see feedback and can't double-tap Generate
    setStatus('loading');
    setLoadingPhase('writing');
    setErrorMessage('');
    setAudioUri(null);
    setSavedCustomId(null);
    setSegmentFileUris(null);
    setSegmentPauseDurations(null);
    setCustomPepPlaybackFinished(false);
    setFlowSessionId(null);
    setFlowSessionPartIndex(0);

    // Build cache key from inputs (same inputs => replay cached audio)
    let outcomeString: string | null = null;
    let obstacleString: string | null = null;
    if (!isFreeTier) {
      if (selectedOutcome === 'other') outcomeString = outcomeOther.trim();
      else if (selectedOutcome && selectedOutcome !== 'skip') outcomeString = selectedOutcome;
      if (selectedObstacle === 'other') obstacleString = obstacleOther.trim();
      else if (selectedObstacle && selectedObstacle !== 'skip') obstacleString = selectedObstacle;
    }
    const apiTone = HONESTY_LEVELS[honestyLevel].apiTone;
    const voiceProfileId = isFreeTier ? null : selectedVoiceProfileId;
    const voiceForRequest: VoiceProfileId | null = isFreeTier ? null : (selectedVoiceProfileId ?? 'coach_m');
    const intentsToSend = [...selectedIntents].sort();
    const intentOtherToSend = selectedIntents.includes('Other') && intentOther.trim() ? intentOther.trim() : null;
    const cacheKey = [
      goalText.trim(),
      String(outcomeString ?? ''),
      String(obstacleString ?? ''),
      intentsToSend.join(','),
      String(intentOtherToSend ?? ''),
      apiTone,
      String(voiceForRequest ?? ''),
      targetSeconds,
    ].join('|');

    const cached = lastCustomCachedResultRef.current;
    if (cacheKey === lastCustomCacheKeyRef.current && cached?.fileUri) {
      setAudioUri(cached.fileUri);
      setCurrentScriptText(cached.scriptText);
      setCurrentVoiceProfileId(voiceForRequest);
      setSegmentFileUris(cached.segmentFileUris);
      setSegmentPauseDurations(cached.segmentPauseDurations);
      if (cached.segmentPauseMs) setSegmentPauseMs(cached.segmentPauseMs);
      setStatus('ready');
      setErrorMessage('');
      try {
        if (cached.segmentFileUris?.length) {
          const estimatedMinutes = targetSeconds / 60;
          await playChunkedSegments(cached.segmentFileUris, cached.segmentPauseMs ?? 450, cached.segmentPauseDurations ?? undefined, estimatedMinutes);
        } else {
          await playFromUri(cached.fileUri, 'custom');
        }
      } catch (_) {
        // ignore
      }
      return;
    }

    // Stop any currently playing audio
    await stopPlayback();

    const tier: 'free' | 'pro' | 'flow' = entitlement;
    const generationId = ++generationIdRef.current;
    try {
      setAudioError(null);

      const { requestId, scriptText, wordCount: scriptWordCount } = await generatePepScriptOnly(
        goalText.trim(),
        tier,
        apiTone,
        voiceForRequest,
        outcomeString,
        obstacleString,
        intentsToSend,
        intentOtherToSend,
        targetSeconds,
        (phase) => setLoadingPhase(phase)
      );
      if (generationIdRef.current !== generationId) return;

      setCurrentScriptText(scriptText);
      if (typeof scriptWordCount === 'number') setLastGeneratedWordCount(scriptWordCount);
      setLoadingPhase('voicing');

      const result = await generatePepAudioOnly(
        requestId,
        scriptText,
        tier,
        apiTone,
        voiceForRequest,
        targetSeconds,
        (phase) => setLoadingPhase(phase)
      );
      if (generationIdRef.current !== generationId) return;

      const { fileUri, segmentFileUris: segUris, segmentPauseMs: segPauseMs, segmentPauseDurations: segPauseDurations } = result;
      setAudioUri(fileUri);
      setSegmentFileUris(segUris ?? null);
      if (segPauseMs != null) setSegmentPauseMs(segPauseMs);
      setSegmentPauseDurations(segPauseDurations ?? null);
      setCurrentVoiceProfileId(voiceForRequest);
      setLastGeneratedRequestedSeconds(targetSeconds);
      setStatus('ready');
      lastCustomCacheKeyRef.current = cacheKey;
      lastCustomCachedResultRef.current = {
        fileUri,
        scriptText,
        segmentFileUris: segUris ?? null,
        segmentPauseMs: segPauseMs ?? 450,
        segmentPauseDurations: segPauseDurations ?? null,
      };
      // If pep-ready notifications are enabled and supported (dev/standalone build), fire a "pep ready" notification.
      if (isReminderSupported()) {
        getPepReadyEnabled()
          .then((enabled) => {
            if (enabled) notifyPepReady('custom').catch(() => {});
          })
          .catch(() => {});
      }
      recordCustomPepGenerated().catch(() => {});
      recordPepProfileUsage({
        intents: intentsToSend,
        intensity: apiTone,
        voiceProfileId: voiceForRequest ?? 'coach_m',
        outcome: outcomeString,
        obstacle: obstacleString,
      }).then(() => {
        if (entitlement === 'flow') {
          getUserPepProfileSummary().then(setUserPepProfileSummary);
        }
      }).catch(() => {});

      console.log('[PEP] ✅ Generation complete, starting playback...');
      try {
        if (segUris?.length) {
          const estimatedMinutes = targetSeconds / 60;
          await playChunkedSegments(segUris, segPauseMs ?? 450, segPauseDurations ?? undefined, estimatedMinutes);
          console.log('[PEP] ✅ Chunked playback started');
        } else {
          await playFromUri(fileUri, 'custom');
          console.log('[PEP] ✅ Playback started');
        }
      } catch (playError) {
        console.error('[PEP] ❌ Error starting playback:', playError);
        Alert.alert('Audio Ready', 'Pep talk generated! Tap Play to listen.');
      }
    } catch (err) {
      if (generationIdRef.current !== generationId) return;
      console.error('[PEP] Generate failed:', err);
      const errorMsg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setErrorMessage(errorMsg);
      // If script arrived but audio failed, keep script and expose retry via audioError
      if (currentScriptText) {
        setAudioError(errorMsg);
        setStatus('idle');
      } else {
        setStatus('error');
      }
    } finally {
      setLoadingPhase(null);
      setStatus((s) => (s === 'loading' ? 'error' : s));
    }
  };

  const handleSave = async () => {
    if (!audioUri || !currentScriptText) {
      Alert.alert('Error', 'No pep talk to save');
      return;
    }

    // Only Pro and Flow can save
    if (entitlement !== 'pro' && entitlement !== 'flow') {
      Alert.alert(
        'Saving is Pro',
        'Saving is Pro. Daily Pep is always free to replay.',
        [{ text: 'Go Pro', onPress: () => router.push('/paywall') }, { text: 'OK' }]
      );
      return;
    }

    try {
      let lengthSeconds = 0;
      try {
        const { sound: tempSound } = await Audio.Sound.createAsync({ uri: audioUri });
        const status = await tempSound.getStatusAsync();
        if (status.isLoaded && status.durationMillis) {
          lengthSeconds = Math.round(status.durationMillis / 1000);
        }
        await tempSound.unloadAsync();
      } catch (e) {
        console.log('Could not get audio duration:', e);
      }

      const voiceProfileId = currentVoiceProfileId ?? 'coach_m';
      const intensityLevel = HONESTY_LEVELS[honestyLevel].apiTone;
      const outcomeStr = selectedOutcome === 'other' ? outcomeOther.trim() || null
        : selectedOutcome && selectedOutcome !== 'skip' ? selectedOutcome : null;
      const obstacleStr = selectedObstacle === 'other' ? obstacleOther.trim() || null
        : selectedObstacle && selectedObstacle !== 'skip' ? selectedObstacle : null;
      const title = derivePepTitle({
        userText: goalText,
        outcome: outcomeStr,
        obstacle: obstacleStr,
      });

      const intentsToSend = [...selectedIntents];
      const intentsForStorage = intentsToSend.length ? intentsToSend : null;
      const intentOtherForStorage =
        selectedIntents.includes('Other') && intentOther.trim() ? intentOther.trim() : null;

      const item = await savePep({
        kind: 'custom',
        title,
        text: currentScriptText,
        audioUriLocal: audioUri,
        voiceProfileId,
        intensityLevel,
        lengthSecondsRequested: lengthSeconds,
        outcome: outcomeStr,
        obstacle: obstacleStr,
        promptText: goalText.trim() || null,
        intents: intentsForStorage,
        intentOther: intentOtherForStorage,
        ...(flowSessionId ? { sessionId: flowSessionId, sessionPartIndex: flowSessionPartIndex } : {}),
      });
      setSavedCustomId(item.id);
      Alert.alert('Saved!', 'Your pep talk has been saved to your library.');
    } catch (err) {
      console.error('Save Error:', err);
      Alert.alert('Error', 'Failed to save pep talk');
    }
  };

  const handleUnsaveCustom = async () => {
    if (!savedCustomId) return;
    try {
      await unsavePep(savedCustomId);
      setSavedCustomId(null);
    } catch (err) {
      console.error('Unsave Error:', err);
      Alert.alert('Error', 'Failed to remove from library');
    }
  };

  // Flow-only: generate continuation with previous pep summary and increased intensity
  const handleContinueSession = async () => {
    if (entitlement !== 'flow' || !currentScriptText?.trim() || !goalText.trim()) return;
    const sid = flowSessionId ?? generateSessionId();
    if (!flowSessionId) setFlowSessionId(sid);
    // Backfill first part into session so both parts share sessionId for playlist
    if (savedCustomId) {
      await updatePepSession(savedCustomId, sid, 0);
    } else if (audioUri && currentScriptText) {
      try {
        let lengthSeconds = 0;
        try {
          const { sound: tempSound } = await Audio.Sound.createAsync({ uri: audioUri });
          const status = await tempSound.getStatusAsync();
          if (status.isLoaded && status.durationMillis) lengthSeconds = Math.round(status.durationMillis / 1000);
          await tempSound.unloadAsync();
        } catch (_) {}
        const outcomeStr = selectedOutcome === 'other' ? outcomeOther.trim() || null : (selectedOutcome && selectedOutcome !== 'skip' ? selectedOutcome : null);
        const obstacleStr = selectedObstacle === 'other' ? obstacleOther.trim() || null : (selectedObstacle && selectedObstacle !== 'skip' ? selectedObstacle : null);
        const title = derivePepTitle({ userText: goalText, outcome: outcomeStr, obstacle: obstacleStr });
        const intentsToSend = [...selectedIntents];
        const intentsForStorage = intentsToSend.length ? intentsToSend : null;
        const intentOtherForStorage =
          selectedIntents.includes('Other') && intentOther.trim() ? intentOther.trim() : null;

        const item = await savePep({
          kind: 'custom',
          title,
          text: currentScriptText,
          audioUriLocal: audioUri,
          voiceProfileId: currentVoiceProfileId ?? 'coach_m',
          intensityLevel: HONESTY_LEVELS[honestyLevel].apiTone,
          lengthSecondsRequested: lengthSeconds,
          outcome: outcomeStr,
          obstacle: obstacleStr,
          promptText: goalText.trim() || null,
          intents: intentsForStorage,
          intentOther: intentOtherForStorage,
          sessionId: sid,
          sessionPartIndex: 0,
        });
        setSavedCustomId(item.id);
      } catch (e) {
        console.warn('[Continue] Save part 0 failed:', e);
      }
    }
    setStatus('loading');
    setLoadingPhase('writing');
    setErrorMessage('');
    setAudioUri(null);
    setSavedCustomId(null);
    setSegmentFileUris(null);
    setSegmentPauseDurations(null);
    setCustomPepPlaybackFinished(false);
    await stopPlayback();
    const apiTone = HONESTY_LEVELS[honestyLevel].apiTone;
    const continuationTone = getContinuationTone(apiTone);
    const voiceProfileId = selectedVoiceProfileId;
    const outcomeString = selectedOutcome === 'other' ? outcomeOther.trim() || null : (selectedOutcome && selectedOutcome !== 'skip' ? selectedOutcome : null);
    const obstacleString = selectedObstacle === 'other' ? obstacleOther.trim() || null : (selectedObstacle && selectedObstacle !== 'skip' ? selectedObstacle : null);
    const intentsToSend = [...selectedIntents].sort();
    const intentOtherToSend = selectedIntents.includes('Other') && intentOther.trim() ? intentOther.trim() : null;
    const summary = currentScriptText.trim().slice(0, 400);
    try {
      const result = await generatePepTalk(
        goalText.trim(),
        'flow',
        continuationTone,
        voiceProfileId,
        outcomeString,
        obstacleString,
        intentsToSend,
        intentOtherToSend,
        null,
        targetSeconds,
        (phase) => setLoadingPhase(phase),
        summary,
        true
      );
      const { scriptText, fileUri, wordCount: resultWordCount, segmentFileUris: segUris, segmentPauseMs: segPauseMs, segmentPauseDurations: segPauseDurations } = result;
      if (!fileUri) {
        setCurrentScriptText(scriptText);
        setStatus('refused');
        setLoadingPhase(null);
        return;
      }
      setFlowSessionPartIndex(1);
      setAudioUri(fileUri);
      setCurrentScriptText(scriptText);
      setCurrentVoiceProfileId(voiceProfileId);
      setLastGeneratedRequestedSeconds(targetSeconds);
      setLastGeneratedWordCount(typeof resultWordCount === 'number' ? resultWordCount : null);
      if (segUris?.length) {
        setSegmentFileUris(segUris);
        setSegmentPauseMs(segPauseMs ?? 450);
        setSegmentPauseDurations(segPauseDurations ?? null);
      } else {
        setSegmentFileUris(null);
        setSegmentPauseDurations(null);
      }
      lastCustomCacheKeyRef.current = '';
      setStatus('ready');
      recordCustomPepGenerated().catch(() => {});
      try {
        if (segUris?.length) {
          const estimatedMinutes = targetSeconds / 60;
          await playChunkedSegments(segUris, segPauseMs ?? 450, segPauseDurations ?? undefined, estimatedMinutes);
        } else {
          await playFromUri(fileUri, 'custom');
        }
      } catch (playErr) {
        console.warn('[PEP] Continue playback start failed:', playErr);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Try again.';
      setErrorMessage(errorMsg);
      setStatus('error');
    } finally {
      setLoadingPhase(null);
    }
  };

  const handleSaveDailyPep = async () => {
    if (!dailyAudioUri || !dailyScriptText) {
      Alert.alert('Error', 'No daily pep talk to save');
      return;
    }

    // Only Pro and Flow can save
    if (entitlement !== 'pro' && entitlement !== 'flow') {
      Alert.alert(
        'Saving is Pro',
        'Saving is Pro. Daily Pep is always free to replay.',
        [{ text: 'Go Pro', onPress: () => router.push('/paywall') }, { text: 'OK' }]
      );
      return;
    }

    try {
      let lengthSeconds = 0;
      try {
        const { sound: tempSound } = await Audio.Sound.createAsync({ uri: dailyAudioUri });
        const status = await tempSound.getStatusAsync();
        if (status.isLoaded && status.durationMillis) {
          lengthSeconds = Math.round(status.durationMillis / 1000);
        }
        await tempSound.unloadAsync();
      } catch (e) {
        console.log('Could not get audio duration:', e);
      }

      const title = dailyTopic ? `${dailyTopic} — Today's Pep` : "Today's Pep";
      const item = await savePep({
        kind: 'daily',
        title,
        text: dailyScriptText,
        audioUriLocal: dailyAudioUri,
        voiceProfileId: 'alloy',
        intensityLevel: 'direct',
        lengthSecondsRequested: lengthSeconds,
        outcome: null,
        obstacle: null,
        promptText: null,
        intents: null,
        intentOther: null,
      });
      setSavedDailyId(item.id);
      Alert.alert('Saved!', 'Your daily pep talk has been saved to your library.');
    } catch (err) {
      console.error('Save Daily Pep Error:', err);
      Alert.alert('Error', 'Failed to save daily pep talk');
    }
  };

  const handleUnsaveDaily = async () => {
    if (!savedDailyId) return;
    try {
      await unsavePep(savedDailyId);
      setSavedDailyId(null);
    } catch (err) {
      console.error('Unsave Daily Error:', err);
      Alert.alert('Error', 'Failed to remove from library');
    }
  };

  // Helper function to truncate script at sentence boundary
  const truncateAtSentence = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) return text;
    
    // Find the last sentence boundary before maxLength
    const truncated = text.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastExclamation = truncated.lastIndexOf('!');
    const lastQuestion = truncated.lastIndexOf('?');
    
    const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
    
    if (lastSentenceEnd > maxLength * 0.7) {
      // If we found a sentence end reasonably close to maxLength, use it
      return text.substring(0, lastSentenceEnd + 1);
    }
    
    // Otherwise just truncate at maxLength
    return truncated;
  };

  const handleDailyPress = async (): Promise<void> => {
    // VERY TOP: Set debug state and log
    const pressTime = new Date().toLocaleTimeString();
    setDailyDebug("Pressed: " + pressTime);
    console.log("[DAILY] pressed");
    
    // Check cache first
    const today = getTodayKey();
    const cached = await loadCachedDailyPep();
    
    // If cached audio exists for today, verify file and play it
    if (cached.date === today && cached.audioUri && dailyAudioUri === cached.audioUri) {
      console.log("[DAILY] Using cached audio for today");
      try {
        const fileInfo = await FileSystemLegacy.getInfoAsync(cached.audioUri);
        if (fileInfo.exists) {
          // File exists, just play it
          await playFromUri(cached.audioUri, 'daily');
          return;
        } else {
          // File missing, clear cache and regenerate
          console.log("[DAILY] cached file missing -> regenerate");
          await clearCachedDailyPep();
        }
      } catch (error) {
        console.error("[DAILY] Error checking cached file:", error);
        await clearCachedDailyPep();
      }
    }
    
    // If we have dailyAudioUri in state for today, just play it
    if (dailyAudioUri) {
      try {
        const fileInfo = await FileSystemLegacy.getInfoAsync(dailyAudioUri);
        if (fileInfo.exists) {
          console.log("[DAILY] Playing existing dailyAudioUri");
          await playFromUri(dailyAudioUri, 'daily');
          return;
        }
      } catch (error) {
        console.error("[DAILY] Error checking dailyAudioUri file:", error);
      }
    }
    
    // No valid cache, need to generate (or preload is in progress)
    if (dailyLoadInProgressRef.current) {
      userTappedDailyDuringPreloadRef.current = true;
      setDailyIsLoading(true);
      return;
    }
    dailyLoadInProgressRef.current = true;
    setDailyDebug("Using API_URL: " + apiBaseUrl);
    console.log("[DAILY] API_URL:", apiBaseUrl);
    
    // Check for localhost
    if (apiBaseUrl.includes("localhost") || apiBaseUrl.includes("127.0.0.1")) {
      const errorMsg = "ERROR: API_URL is localhost (phone cannot reach it)";
      setDailyDebug(errorMsg);
      console.log("[DAILY]", errorMsg);
      dailyLoadInProgressRef.current = false;
      return;
    }
    
    setDailyIsLoading(true);
    setDailyError(null);
    
    // Stop any currently playing audio
    await stopPlayback();

    try {
      // Get today's topic and quote deterministically
      setDailyDebug("Getting today's topic and quote...");
      console.log("[DAILY] Getting today's topic and quote...");
      const todayPep = getTodayDailyPep();
      const topic = todayPep.topic;
      const quote = todayPep.quote;
      
      // Update state if not already set
      if (!dailyTopic || !dailyQuote) {
        setDailyTopic(topic);
        setDailyQuote(quote);
      }

      // Flow: Personal Daily Pep via /pep with profile
      if (entitlement === 'flow') {
        setDailyDebug("Loading your profile...");
        const profile = await getUserPepProfileSummary();
        const userTextDaily = `${topic}. ${quote}`;
        const validTones = ['easy', 'steady', 'direct', 'blunt', 'no_excuses'] as const;
        const flowTone = validTones.includes(profile.mostUsedIntensity as typeof validTones[number])
          ? (profile.mostUsedIntensity as typeof validTones[number])
          : 'direct';
        setDailyDebug("Generating your personal pep...");
        try {
          const { scriptText: flowScript, fileUri: flowUri } = await generatePepTalk(
            userTextDaily,
            'flow',
            flowTone,
            profile.mostUsedVoiceProfile as VoiceProfileId,
            profile.commonOutcome,
            profile.commonObstacle,
            profile.topIntents,
            null,
            profile.profileSummary,
            45,
            undefined
          );
          if (flowUri) {
            setDailyScriptText(flowScript);
            setDailyAudioUri(flowUri);
            const today = getTodayKey();
            await saveCachedDailyPep({ date: today, topic, quote, audioUri: flowUri });
            setDailyIsLoading(false);
            await playFromUri(flowUri, 'daily');
          } else {
            setDailyError("Couldn't generate personal pep. Try again.");
            setDailyIsLoading(false);
          }
        } catch (flowErr) {
          const msg = flowErr instanceof Error ? flowErr.message : 'Failed to generate personal pep';
          setDailyError(msg);
          setDailyIsLoading(false);
          setTimeout(() => Alert.alert('Error', msg), 0);
        }
        return;
      }

      // Generate script locally (~30–45s when spoken), kept lean enough that TTS is still fast
      setDailyDebug("Generating script...");
      console.log("[DAILY] Generating script...");
      const dailyScript = buildDailyScriptForTts(topic, quote);
      setDailyDebug("Daily script length: " + dailyScript.length);
      console.log("[DAILY] Final script length:", dailyScript.length);
      
      // Store script text for saving
      setDailyScriptText(dailyScript);

      // Call TTS API to get audio
      setDailyDebug("Fetching TTS...");
      console.log("[DAILY] Fetching TTS from:", `${apiBaseUrl}/tts`);
      const dailyVoiceProfileId: VoiceProfileId = selectedVoiceProfileId ?? 'coach_m';
      const dailyOpenAIVoice = VOICE_PROFILES[dailyVoiceProfileId].openAIVoice;
      
      console.log(
        "[DAILY] Request body:",
        JSON.stringify({ text: dailyScript.substring(0, 50) + '...', voice: dailyOpenAIVoice })
      );      
      // Test connection first
      const connectionTest = await testApiConnection(apiBaseUrl);
      if (!connectionTest.success) {
        const errorMsg = connectionTest.error || 'Cannot connect to API';
        const details = connectionTest.details ? `\n\nDetails: ${connectionTest.details}` : '';
        setDailyDebug("Connection test failed: " + errorMsg);
        console.log("[DAILY] Connection test failed:", errorMsg, details);
        throw new Error(errorMsg + details);
      }
      
      setDailyDebug("Connection OK, requesting TTS...");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
      const response = await fetch(`${apiBaseUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: dailyScript,
          voice: dailyOpenAIVoice,
singleVoice: true, // full script must be one voice (no mid-talk change)
        }),
        signal: controller.signal,
      }).then((res) => {
        clearTimeout(timeoutId);
        setDailyDebug("Got response: " + res.status);
        console.log("[DAILY] Got response");
        console.log("[DAILY] HTTP status:", res.status);
        console.log("[DAILY] Response ok:", res.ok);
        console.log("[DAILY] Response headers:", JSON.stringify(Object.fromEntries(res.headers.entries())));
        return res;
      }).catch((fetchError: unknown) => {
        clearTimeout(timeoutId);
        const err = fetchError as Error;
        if (err?.name === 'AbortError') {
          throw new Error('Taking longer than usual. Please try again.');
        }
        const msg = err?.message ?? '';
        if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('timeout')) {
          throw new Error('No connection. Check your network and try again.');
        }
        throw new Error('Try again.');
      });

      if (!response.ok) {
        await response.json().catch(() => ({}));
        throw new Error('Try again.');
      }

      const data = await response.json();
      console.log("[DAILY] Response data keys:", Object.keys(data));
      const { audioBase64 } = data;

      if (!audioBase64) {
        setDailyDebug("No audio data received");
        console.log("[DAILY] No audio data received");
        throw new Error('No audio data received');
      }

      setDailyDebug("Audio received, length: " + audioBase64.length);
      console.log("[DAILY] Audio received, length:", audioBase64.length);

      // Save audio file
      setDailyDebug("Saving audio file...");
      console.log("[DAILY] Saving audio file...");
      const fs = FileSystem as any;
      let cacheDir: string | null = null;
      
      try {
        const cacheDirectory = fs.Paths?.cache || fs.Paths?.document;
        if (cacheDirectory) {
          cacheDir = cacheDirectory.uri || String(cacheDirectory);
        }
      } catch (e) {
        console.log("[DAILY] Error getting cache directory (new API):", e);
      }
      
      if (!cacheDir) {
        cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
      }
      
      if (!cacheDir) {
        if (Platform.OS === 'web') {
          const dataUri = `data:audio/mpeg;base64,${audioBase64}`;
          setDailyAudioUri(dataUri);
          console.log("[DAILY] Audio URI set (web):", dataUri.substring(0, 50) + '...');
          
          // Save to cache
          const today = getTodayKey();
          await saveCachedDailyPep({
            date: today,
            topic: topic,
            quote: quote,
            audioUri: dataUri,
          });
          
          setDailyIsLoading(false);
          
          // Immediately play the audio after it's saved
          console.log("[DAILY] Starting playback (web)...");
          await playFromUri(dataUri, 'daily');
          return;
        }
        const errorMsg = 'File system not available';
        setDailyDebug(errorMsg);
        console.log("[DAILY]", errorMsg);
        throw new Error(errorMsg);
      }
      
      if (!cacheDir.endsWith('/')) {
        cacheDir += '/';
      }
      
      const fileUri = `${cacheDir}daily_${Date.now()}.mp3`;
      
      await FileSystemLegacy.writeAsStringAsync(fileUri, audioBase64, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      
      setDailyAudioUri(fileUri);
      console.log("[DAILY] Audio URI set:", fileUri);
      await pruneAudioCache(cacheDir, MAX_AUDIO_CACHE_FILES);

      // Save to cache
      const today = getTodayKey();
      await saveCachedDailyPep({
        date: today,
        topic: topic,
        quote: quote,
        audioUri: fileUri,
      });
      
      setDailyIsLoading(false);
      
      // Immediately play the audio after it's saved
      console.log("[DAILY] Starting playback...");
      await playFromUri(fileUri, 'daily');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Try again.';
      setDailyError(errorMsg);
      setDailyIsLoading(false);
    } finally {
      setDailyIsLoading(false);
      dailyLoadInProgressRef.current = false;
    }
  };

  // Shared stop playback function
  const stopPlayback = async (): Promise<void> => {
    console.log("[AUDIO] stopPlayback called");
    if (chunkedTimeoutRef.current) {
      clearTimeout(chunkedTimeoutRef.current);
      chunkedTimeoutRef.current = null;
    }
    nextChunkIndexRef.current = null;
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch (err) {
        console.log("[AUDIO] Error stopping sound:", err);
      }
      soundRef.current = null;
      setCurrentSound(null);
    }
    setSound(null);
    setIsPlaying(false);
    setIsPaused(false);
    setNowPlaying(null);
    setNowPlayingId(null);
  };

  // Reusable function to play audio from URI
  const playFromUri = async (
    uri: string,
    source: 'daily' | 'custom' | 'library' | 'preview',
    id?: string
  ): Promise<void> => {
    console.log("[AUDIO] playFromUri start:", uri, "source:", source, "id:", id);
    
    try {
      // Ensure playback uses speaker and is audible (Android: not earpiece; iOS: speaker + silent mode)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        playThroughEarpieceAndroid: false,
        shouldDuckAndroid: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      });
      // Stop any current playback (e.g. from Library tab) so only one sound plays
      await stopCurrent();
      // Track replays: if same URI is played again, increment replay count
      if (lastPlayedUriRef.current === uri) {
        setReplayCount(prev => {
          const newCount = prev + 1;
          // Show Flow prompt after 2+ replays
          if (newCount >= 2) {
            showFlowPromptIfNeeded('replay');
          }
          return newCount;
        });
      } else {
        // New URI, reset replay count
        setReplayCount(0);
        lastPlayedUriRef.current = uri;
      }
      
      // Stop and unload existing sound if any
      await stopPlayback();

      // Load and play new audio
      console.log("[AUDIO] Loading audio from URI...", uri);
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true }
      );

      // Explicit full volume (Android emulator often ignores system volume or defaults to 0)
      await newSound.setVolumeAsync(1.0);
      const statusAfterLoad = await newSound.getStatusAsync();
      if (statusAfterLoad.isLoaded && !statusAfterLoad.isPlaying) {
        await newSound.playAsync();
      }

      soundRef.current = newSound;
      setSound(newSound);
      setCurrentSound(newSound);
      setIsPlaying(true);
      setIsPaused(false);
      setNowPlaying(source);
      setNowPlayingId(id || null);
      console.log("[AUDIO] loaded + playing, nowPlaying:", source);

      // Handle playback status
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded) {
            if (status.didJustFinish) {
            console.log("[AUDIO] finished");
            setIsPlaying(false);
            setIsPaused(false);
            setNowPlaying(null);
            setNowPlayingId(null);
            if (source === 'custom') setCustomPepPlaybackFinished(true);
            const durationMillis = status.durationMillis ?? 0;
            const minutesListened = durationMillis / 60000;
            recordPepPlayed(minutesListened).catch(() => {});
            if (source === 'daily') {
              recordDailyPepPlayed()
                .then(() => loadHabitMetrics())
                .then(setHabitMetrics)
                .catch(() => {});
            }
            // Feedback prompt disabled in production – preserve logic for future use.
            // const pepId = source === 'daily' ? getTodayKey() : (id ?? `custom-${Date.now()}`);
            // setFeedbackPepId(pepId);
            // setFeedbackPepKind(source === 'daily' ? 'daily' : 'custom');
            // setFeedbackStep('main');
            // getSkipFeedbackAfterPep().then((skip) => { if (!skip) setShowFeedbackModal(true); });
          }
        }
      });
    } catch (err) {
      console.error("[AUDIO] Playback Error:", err);
      setIsPlaying(false);
      setIsPaused(false);
      setNowPlaying(null);
      setNowPlayingId(null);
      Alert.alert('Error', 'Failed to play audio');
    }
  };

  // Chunked TTS: play segments sequentially; pause after segment i = segmentPauseDurations?.[i] (seconds) or default pauseMs
  const playChunkedSegments = async (
    uris: string[],
    defaultPauseMs: number,
    pauseDurationsSeconds?: number[] | null,
    estimatedMinutes?: number
  ): Promise<void> => {
    if (!uris.length) return;
    const hasCuePauses = Array.isArray(pauseDurationsSeconds) && pauseDurationsSeconds.length === uris.length;
    console.log("[AUDIO] playChunkedSegments start:", uris.length, "segments", hasCuePauses ? "(cue-derived pauses)" : `(default ${defaultPauseMs}ms)`);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        playThroughEarpieceAndroid: false,
        shouldDuckAndroid: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      });
      await stopCurrent();
      await stopPlayback();

      segmentFileUrisRef.current = uris;
      segmentPauseMsRef.current = defaultPauseMs;
      segmentPauseDurationsRef.current = hasCuePauses ? pauseDurationsSeconds : null;

      const pauseMsAfter = (index: number) => {
        const dur = segmentPauseDurationsRef.current?.[index];
        if (typeof dur === 'number' && dur >= 0) return Math.round(dur * 1000);
        return defaultPauseMs;
      };

      const playSegment = async (index: number) => {
        currentChunkIndexRef.current = index;
        if (index >= uris.length) {
          setIsPlaying(false);
          setNowPlaying(null);
          setNowPlayingId(null);
          return;
        }
        const uri = uris[index];
        const { sound: newSound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
        await newSound.setVolumeAsync(1.0);
        soundRef.current = newSound;
        setSound(newSound);
        setCurrentSound(newSound);
        setIsPlaying(true);
        setIsPaused(false);
        setNowPlaying('custom');
        setNowPlayingId(null);
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            const next = index + 1;
            if (next < uris.length) {
              nextChunkIndexRef.current = next;
              const delayMs = pauseMsAfter(index);
              chunkedTimeoutRef.current = setTimeout(() => {
                chunkedTimeoutRef.current = null;
                playSegment(next);
              }, delayMs);
            } else {
              setIsPlaying(false);
              setNowPlaying(null);
              setNowPlayingId(null);
              setCustomPepPlaybackFinished(true);
              recordPepPlayed(estimatedMinutes ?? 0).catch(() => {});
              // Feedback prompt disabled in production – preserve logic for future use.
              // setFeedbackPepId(`custom-${Date.now()}`);
              // setFeedbackPepKind('custom');
              // setFeedbackStep('main');
              // getSkipFeedbackAfterPep().then((skip) => { if (!skip) setShowFeedbackModal(true); });
            }
          }
        });
      };

      await playSegment(0);
    } catch (err) {
      console.error("[AUDIO] Chunked playback error:", err);
      setIsPlaying(false);
      setNowPlaying(null);
      Alert.alert('Error', 'Failed to play audio');
    }
  };

  // Streaming playback: play segments from refs as they arrive; poll for next until stream done
  const playStreamingSegments = async (defaultPauseMs: number) => {
    const uris = segmentFileUrisRef.current ?? [];
    if (!uris.length) return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        playThroughEarpieceAndroid: false,
        shouldDuckAndroid: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      });
      await stopCurrent();
      await stopPlayback();
    } catch (_) {}
    const pauseMsAfter = (index: number) => {
      const dur = segmentPauseDurationsRef.current?.[index];
      if (typeof dur === 'number' && dur >= 0) return Math.round(dur * 1000);
      return defaultPauseMs;
    };
    const playSegment = async (index: number) => {
      currentChunkIndexRef.current = index;
      const list = segmentFileUrisRef.current ?? [];
      if (index >= list.length) {
        if (streamDoneRef.current) {
          setIsPlaying(false);
          setNowPlaying(null);
          setNowPlayingId(null);
          setCustomPepPlaybackFinished(true);
          const estimatedMinutes = (targetSeconds ?? 30) / 60;
          recordPepPlayed(estimatedMinutes).catch(() => {});
          // Feedback prompt disabled in production – preserve logic for future use.
          // setFeedbackPepId(`custom-${Date.now()}`);
          // setFeedbackPepKind('custom');
          // setFeedbackStep('main');
          // getSkipFeedbackAfterPep().then((skip) => { if (!skip) setShowFeedbackModal(true); });
        }
        return;
      }
      const uri = list[index];
      const { sound: newSound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
      await newSound.setVolumeAsync(1.0);
      soundRef.current = newSound;
      setSound(newSound);
      setCurrentSound(newSound);
      setIsPlaying(true);
      setIsPaused(false);
      setNowPlaying('custom');
      setNowPlayingId(null);
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          const next = index + 1;
          const currentList = segmentFileUrisRef.current ?? [];
          if (next < currentList.length) {
            nextChunkIndexRef.current = next;
            const delayMs = pauseMsAfter(index);
            chunkedTimeoutRef.current = setTimeout(() => {
              chunkedTimeoutRef.current = null;
              playSegment(next);
            }, delayMs);
          } else if (streamDoneRef.current) {
            setIsPlaying(false);
            setNowPlaying(null);
            setNowPlayingId(null);
            setCustomPepPlaybackFinished(true);
            const estimatedMinutes = (targetSeconds ?? 30) / 60;
            recordPepPlayed(estimatedMinutes).catch(() => {});
            setFeedbackPepId(`custom-${Date.now()}`);
            setFeedbackPepKind('custom');
            setFeedbackStep('main');
            getSkipFeedbackAfterPep().then((skip) => { if (!skip) setShowFeedbackModal(true); });
          } else {
            const waitNext = () => {
              const l = segmentFileUrisRef.current ?? [];
              if (next < l.length) {
                nextChunkIndexRef.current = next;
                chunkedTimeoutRef.current = setTimeout(() => {
                  chunkedTimeoutRef.current = null;
                  playSegment(next);
                }, pauseMsAfter(index));
              } else if (streamDoneRef.current) {
                setIsPlaying(false);
                setNowPlaying(null);
                setNowPlayingId(null);
                setCustomPepPlaybackFinished(true);
                const estimatedMinutes = (targetSeconds ?? 30) / 60;
                recordPepPlayed(estimatedMinutes).catch(() => {});
                setFeedbackPepId(`custom-${Date.now()}`);
                setFeedbackPepKind('custom');
                setFeedbackStep('main');
                getSkipFeedbackAfterPep().then((skip) => { if (!skip) setShowFeedbackModal(true); });
              } else {
                chunkedTimeoutRef.current = setTimeout(waitNext, 150);
              }
            };
            chunkedTimeoutRef.current = setTimeout(waitNext, 150);
          }
        }
      });
    };
    segmentPauseMsRef.current = defaultPauseMs;
    playSegment(0);
  };

  // Legacy stopAudio (now uses shared stopPlayback)
  const stopAudio = async (): Promise<void> => {
    await stopPlayback();
  };

  // Custom pep: play (single file or chunked)
  const handlePlay = async () => {
    const now = Date.now();
    if (now - lastPlayTappedAtRef.current < PLAY_DEBOUNCE_MS) return;
    lastPlayTappedAtRef.current = now;
    if (!segmentFileUris?.length && !audioUri) return;
    try {
      if (segmentFileUris?.length) {
        await playChunkedSegments(segmentFileUris, segmentPauseMs, segmentPauseDurations ?? undefined);
      } else if (audioUri) {
        await playFromUri(audioUri, 'custom');
      }
    } catch (e) {
      console.error('[PEP] Play failed:', e);
      const msg = e instanceof Error ? e.message : 'Playback failed';
      Alert.alert('Playback failed', msg + '. Try generating again.');
    }
  };
  const handleDeviceRead = () => {
    if (!currentScriptText?.trim()) return;
    try {
      Speech.stop();
      Speech.speak(currentScriptText, {
        rate: 0.9,
        pitch: 1.0,
      });
    } catch (e) {
      console.warn('[TTS] Device read error:', e);
    }
  };
  // Custom pep: pause (segment or gap between segments)
  const handlePause = async () => {
    if (nowPlaying !== 'custom') return;
    if (soundRef.current) {
      try {
        await soundRef.current.pauseAsync();
        setIsPlaying(false);
        setIsPaused(true);
      } catch (e) {
        console.warn('[AUDIO] Pause error:', e);
      }
    } else if (chunkedTimeoutRef.current) {
      clearTimeout(chunkedTimeoutRef.current);
      chunkedTimeoutRef.current = null;
      setIsPaused(true);
    }
  };

  // Custom pep: resume (segment or from gap)
  const handleResume = async () => {
    if (nowPlaying !== 'custom') return;
    if (soundRef.current) {
      try {
        await soundRef.current.playAsync();
        setIsPlaying(true);
        setIsPaused(false);
      } catch (e) {
        console.warn('[AUDIO] Resume error:', e);
      }
    } else if (nextChunkIndexRef.current != null && segmentFileUrisRef.current?.length) {
      const next = nextChunkIndexRef.current;
      nextChunkIndexRef.current = null;
      const uris = segmentFileUrisRef.current;
      const defaultPauseMs = segmentPauseMsRef.current;
      const pauseMsAfter = (index: number) => {
        const dur = segmentPauseDurationsRef.current?.[index];
        if (typeof dur === 'number' && dur >= 0) return Math.round(dur * 1000);
        return defaultPauseMs;
      };
      const playSegment = async (index: number) => {
        currentChunkIndexRef.current = index;
        if (index >= uris.length) {
          setIsPlaying(false);
          setNowPlaying(null);
          setNowPlayingId(null);
          return;
        }
        const uri = uris[index];
        const { sound: newSound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
        await newSound.setVolumeAsync(1.0);
        soundRef.current = newSound;
        setSound(newSound);
        setCurrentSound(newSound);
        setIsPlaying(true);
        setIsPaused(false);
        setNowPlaying('custom');
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            const n = index + 1;
            if (n < uris.length) {
              nextChunkIndexRef.current = n;
              const delayMs = pauseMsAfter(index);
              chunkedTimeoutRef.current = setTimeout(() => {
                chunkedTimeoutRef.current = null;
                playSegment(n);
              }, delayMs);
            } else {
              setIsPlaying(false);
              setNowPlaying(null);
              setNowPlayingId(null);
            }
          }
        });
      };
      await playSegment(next);
    }
  };

  // Custom pep: stop and reset (unload, next Play starts from 0)
  const handleStop = async () => {
    await stopPlayback();
  };

  const isCustomPlaying = nowPlaying === 'custom' && isPlaying;
  const isCustomPaused = nowPlaying === 'custom' && isPaused;

  const isGenerateDisabled = !goalText.trim() || status === 'loading' || dailyIsLoading;
  const isPlayDisabled = status !== 'ready' || !audioUri;
  const remainingCustomPeps = getRemainingCustomPeps();
  const maxChars = isPro ? PRO_MAX_CHARS : FREE_MAX_CHARS;
  const canRead = entitlement === 'pro' || entitlement === 'flow';
  const isFlow = entitlement === 'flow';
  const isFreeTier = entitlement === 'free';
  
  // Flow prompt messages (short, direct, no sales language)
  const FLOW_PROMPTS = [
    'Flow keeps this going.',
    'Flow removes the stops.',
    'Flow plays them back-to-back.',
  ];
  
  // Show Flow prompt at meaningful moments
  const showFlowPromptIfNeeded = (context: 'replay' | 'second_pep') => {
    // Only show for non-Flow users
    if (isFlow) return;
    
    if (context === 'replay') {
      // After 2+ replays
      if (replayCount >= 2) {
        const message = FLOW_PROMPTS[Math.floor(Math.random() * FLOW_PROMPTS.length)];
        setFlowPromptMessage(message);
        setShowFlowPrompt(true);
        // Auto-hide after 8 seconds
        setTimeout(() => {
          setShowFlowPrompt(false);
        }, 8000);
      }
    } else if (context === 'second_pep') {
      // When user manually starts a second pep
      if (pepStartCount >= 2) {
        const message = FLOW_PROMPTS[Math.floor(Math.random() * FLOW_PROMPTS.length)];
        setFlowPromptMessage(message);
        setShowFlowPrompt(true);
        // Auto-hide after 8 seconds
        setTimeout(() => {
          setShowFlowPrompt(false);
        }, 8000);
      }
    }
  };
  
  // Open reading mode
  const handleOpenReadingMode = (script: string, title: string) => {
    if (!canRead) {
      Alert.alert(
        'Reading Mode is Pro',
        'Reading Mode is available for Pro and Flow users.',
        [{ text: 'Go Pro', onPress: () => router.push('/paywall') }, { text: 'OK' }]
      );
      return;
    }
    setReadingModeScript(script);
    setReadingModeTitle(title);
    setShowReadingMode(true);
  };
  
  // Close reading mode
  const handleCloseReadingMode = () => {
    setShowReadingMode(false);
    setReadingModeScript('');
    setReadingModeTitle('');
  };

  // Feedback handlers (disabled in production – kept for future use)
  // const closeFeedbackModal = () => {
  //   setShowFeedbackModal(false);
  //   setFeedbackStep('main');
  //   setFeedbackPepId(null);
  //   setFeedbackText('');
  // };
  //
  // const handleFeedbackYeah = async () => {
  //   if (!feedbackPepId) return;
  //   const entry: PepFeedbackEntry = {
  //     id: feedbackPepId,
  //     kind: feedbackPepKind,
  //     date: new Date().toISOString(),
  //     rating: 'yeah',
  //     ...(feedbackText.trim() ? { feedbackText: feedbackText.trim() } : {}),
  //   };
  //   await saveFeedback(entry);
  //   closeFeedbackModal();
  // };
  //
  // const handleFeedbackNotReally = () => {
  //   setFeedbackStep('reason');
  // };
  //
  // const handleFeedbackReason = async (reason: FeedbackReason) => {
  //   if (!feedbackPepId) return;
  //   const entry: PepFeedbackEntry = {
  //     id: feedbackPepId,
  //     kind: feedbackPepKind,
  //     date: new Date().toISOString(),
  //     rating: 'not_really',
  //     reason,
  //     ...(feedbackText.trim() ? { feedbackText: feedbackText.trim() } : {}),
  //   };
  //   await saveFeedback(entry);
  //   if (reason === 'too_soft' || reason === 'too_intense') {
  //     const nextLevel = await adjustDefaultHonestyFromFeedback(reason);
  //     setHonestyLevel(nextLevel as HonestyLevel);
  //   }
  //   closeFeedbackModal();
  // };
  //
  // const handleSkipFeedbackToggle = async (value: boolean) => {
  //   setSkipFeedbackAfterPepState(value);
  //   await setSkipFeedbackAfterPep(value);
  // };

  const insets = useSafeAreaInsets();
  const { continueSessionFrom } = useLocalSearchParams<{ continueSessionFrom?: string }>();

  useEffect(() => {
    if (!continueSessionFrom || hasHandledContinueFromLibraryRef.current) return;
    hasHandledContinueFromLibraryRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        const pep = await getPepById(continueSessionFrom);
        if (!pep || cancelled) {
          if (!pep) {
            Alert.alert('Not found', 'That pep could not be found in your library.');
          }
          return;
        }
        if (pep.kind !== 'custom' || !pep.text || !pep.audioUriLocal) {
          Alert.alert('Unavailable', 'This pep cannot be used to continue a session.');
          return;
        }

        setShowCustomPep(true);

        const promptFromPep =
          (typeof pep.promptText === 'string' && pep.promptText.trim().length > 0
            ? pep.promptText
            : pep.title) || '';
        setGoalText(promptFromPep);
        setCurrentScriptText(pep.text);
        setAudioUri(pep.audioUriLocal);
        setCurrentVoiceProfileId(pep.voiceProfileId as VoiceProfileId);
        if (VOICE_PROFILES[pep.voiceProfileId as VoiceProfileId]) {
          setSelectedVoiceProfileId(pep.voiceProfileId as VoiceProfileId);
        }
        setHonestyLevel(toneToHonestyLevel(pep.intensityLevel));

        const minLength = 30;
        const maxLength = entitlement === 'flow' ? 180 : entitlement === 'pro' ? 90 : 30;
        const length = pep.lengthSecondsRequested || minLength;
        const clampedLength = Math.min(maxLength, Math.max(minLength, length));
        setTargetSeconds(clampedLength);

        const outcomeValue = pep.outcome ?? null;
        if (outcomeValue) {
          if ((PRO_OUTCOME_OPTIONS as readonly string[]).includes(outcomeValue)) {
            setSelectedOutcome(outcomeValue as OutcomeOption);
            setOutcomeOther('');
            setShowOutcomeOther(false);
          } else {
            setSelectedOutcome('other');
            setOutcomeOther(outcomeValue);
            setShowOutcomeOther(true);
          }
        } else {
          setSelectedOutcome(null);
          setOutcomeOther('');
          setShowOutcomeOther(false);
        }

        const obstacleValue = pep.obstacle ?? null;
        if (obstacleValue) {
          if ((PRO_OBSTACLE_OPTIONS as readonly string[]).includes(obstacleValue)) {
            setSelectedObstacle(obstacleValue as ObstacleOption);
            setObstacleOther('');
            setShowObstacleOther(false);
          } else {
            setSelectedObstacle('other');
            setObstacleOther(obstacleValue);
            setShowObstacleOther(true);
          }
        } else {
          setSelectedObstacle(null);
          setObstacleOther('');
          setShowObstacleOther(false);
        }

        const pepIntents = Array.isArray(pep.intents) ? pep.intents.map(String) : [];
        setSelectedIntents(pepIntents);
        if (pepIntents.includes('Other') && typeof pep.intentOther === 'string') {
          setIntentOther(pep.intentOther);
        } else {
          setIntentOther('');
        }

        setSavedCustomId(pep.id);

        if (pep.sessionId) {
          setFlowSessionId(pep.sessionId);
          setFlowSessionPartIndex(
            typeof pep.sessionPartIndex === 'number' ? pep.sessionPartIndex : 0
          );
        } else {
          setFlowSessionId(null);
          setFlowSessionPartIndex(0);
        }

        await handleContinueSession();
      } catch (e) {
        if (cancelled) return;
        console.warn('[Home] Failed to continue session from library:', e);
        Alert.alert('Error', 'Could not start a continuation from that pep. Please try again.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [continueSessionFrom, handleContinueSession]);

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 40}>
      <ThemedView style={[styles.container, { backgroundColor: 'transparent' }]}>
        {/* Background gradient */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.backgroundTop,
            },
          ]}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.background,
            },
          ]}
        />
        <ScrollView 
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 20) + 12 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
        
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Pressable
              style={styles.brandRow}
              onLongPress={() => {
                if (!__DEV__) return;
                const now = Date.now();
                const lastPress = (global as any).__devModePressTime || 0;
                const pressCount = (global as any).__devModePressCount || 0;
                if (now - lastPress < 2000) {
                  const newCount = pressCount + 1;
                  (global as any).__devModePressCount = newCount;
                  (global as any).__devModePressTime = now;
                  if (newCount >= 5) {
                    import('@/services/subscription').then(({ setDevModeEnabled }) => {
                      setDevModeEnabled(true);
                      Alert.alert('Dev Mode Enabled', 'Developer mode is now active. Check Settings.');
                      (global as any).__devModePressCount = 0;
                    });
                  }
                } else {
                  (global as any).__devModePressCount = 1;
                  (global as any).__devModePressTime = now;
                }
              }}>
              {/* Brand mark */}
              <View
                style={[
                  styles.brandMark,
                  {
                    borderColor: theme.accentWarm,
                    backgroundColor: theme.surfaceSoft,
                  },
                ]}>
                <ThemedText style={[styles.brandMarkText, { color: theme.accentWarm }]}>
                  P
                </ThemedText>
              </View>

              {/* Title + Tagline */}
              <View style={styles.headerTextBlock}>
                <ThemedText style={[styles.headerTitle, { color: theme.text }]}>Pep</ThemedText>
                <ThemedText style={[styles.headerTagline, { color: theme.mutedText }]}>
                  Make It Happen.
                </ThemedText>
              </View>
            </Pressable>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={async () => {
                if (isRefreshingSubscription) return;
                setIsRefreshingSubscription(true);
                try {
                  await refreshEntitlement();
                  const message = 'Subscription refreshed';
                  if (Platform.OS === 'android') {
                    ToastAndroid.show(message, ToastAndroid.SHORT);
                  } else {
                    Alert.alert('Subscription', message);
                  }
                } catch (error) {
                  Alert.alert('Subscription', 'Could not refresh subscription. Please try again.');
                } finally {
                  setIsRefreshingSubscription(false);
                }
              }}
              style={styles.refreshIconButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {isRefreshingSubscription ? (
                <ActivityIndicator size="small" color={theme.accentWarm} />
              ) : (
                <ThemedText style={[styles.refreshIcon, { color: theme.mutedText }]}>⟳</ThemedText>
              )}
            </TouchableOpacity>
            {(habitMetrics?.streakCount ?? 0) > 0 ? (
              <Animated.View style={[styles.streakBadge, { transform: [{ scale: streakScaleAnim }] }]}>
                <ThemedText style={styles.streakEmoji}>🔥</ThemedText>
                <ThemedText style={[styles.streakCount, { color: theme.accentWarm }]}>
                  {habitMetrics?.streakCount ?? 0}
                </ThemedText>
              </Animated.View>
            ) : (
              <View style={styles.streakBadge}>
                <ThemedText style={styles.streakEmoji}>🔥</ThemedText>
                <ThemedText style={[styles.streakCount, { color: theme.mutedText }]}>0</ThemedText>
              </View>
            )}
          </View>
        </View>

        {/* Header divider */}
        <View
          style={[
            styles.headerDivider,
            { backgroundColor: theme.accentWarmMuted },
          ]}
        />

        {/* Daily Pep Card */}
        <Pressable
          onPress={() => {}}
          style={({ pressed }) => [
            styles.card,
            { 
              backgroundColor: theme.surface,
              shadowColor: theme.accentWarmMuted,
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.1,
              shadowRadius: 8,
            },
            pressed && { opacity: 0.9 },
          ]}>
          <ThemedText style={[styles.cardTitle, { color: theme.text }]}>
            {isFlow ? "Today's Personal Pep" : "Today's Pep"}
          </ThemedText>
          <ThemedText style={[styles.cardSubtitle, { color: theme.mutedText }]}>
            {isFlow && userPepProfileSummary?.topIntents?.length
              ? `Built for: ${userPepProfileSummary.topIntents.join(' + ')}`
              : 'What you need to hear today.'}
          </ThemedText>

          {/* Always show Topic + Quote */}
          {(dailyTopic || dailyQuote) && (
            <Animated.View
              style={[
                styles.dailyPepContent,
                {
                  opacity: dailyPepFadeAnim,
                  transform: [{ translateY: dailyPepTranslateYAnim }],
                },
              ]}>
              {dailyTopic && (
                <ThemedText style={[styles.dailyPepTopicLabel, { color: theme.mutedText }]}>
                  Topic: {dailyTopic}
                </ThemedText>
              )}
              {dailyQuote && (
                <ThemedText style={[styles.dailyPepQuote, { color: theme.mutedText }]}>
                  "{dailyQuote}"
                </ThemedText>
              )}
            </Animated.View>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.cardButton,
              { 
                backgroundColor: theme.accentWarm,
                shadowColor: theme.accentWarm,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.3,
                shadowRadius: 8,
              },
              pressed && { opacity: 0.7 },
            ]}
            onPress={async () => {
              const now = Date.now();
              if (now - lastPlayTappedAtRef.current < PLAY_DEBOUNCE_MS) return;
              lastPlayTappedAtRef.current = now;
              if (nowPlaying === 'daily' && isPlaying) {
                await stopPlayback();
              } else if (dailyAudioUri) {
                console.log('Playing existing daily pep audio');
                await playFromUri(dailyAudioUri, 'daily');
              } else {
                await handleDailyPress();
              }
            }}>
            {dailyIsLoading ? (
              <>
                <ActivityIndicator color={theme.background} style={{ marginRight: 8 }} />
                <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>Getting it ready…</ThemedText>
              </>
            ) : nowPlaying === 'daily' && isPlaying ? (
              <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>Stop</ThemedText>
            ) : dailyAudioUri ? (
              <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>Play today's pep</ThemedText>
            ) : (
              <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>Load today's pep</ThemedText>
            )}
          </Pressable>

          {/* Show error if exists */}
          {dailyError && (
            <ThemedText style={[styles.errorText, { color: theme.error }]}>
              {dailyError}
            </ThemedText>
          )}

          {/* Read and Save Button / Upsell for Daily Pep */}
          {dailyAudioUri && dailyScriptText && (
            <View style={styles.saveSection}>
              {/* Read Toggle (Pro/Flow only) */}
              {canRead && (
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder, marginBottom: 8 }]}
                  onPress={() => handleOpenReadingMode(dailyScriptText, isFlow ? "Today's Personal Pep" : "Today's Pep")}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                    📖 Read
                  </ThemedText>
                </TouchableOpacity>
              )}
              {isPro ? (
                savedDailyId ? (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                    onPress={handleUnsaveDaily}>
                    <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                      ✓ Saved — Tap to remove from Library
                    </ThemedText>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                    onPress={handleSaveDailyPep}>
                    <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                      💾 Save to Library
                    </ThemedText>
                  </TouchableOpacity>
                )
              ) : (
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                  onPress={() => router.push('/paywall')}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                    💾 Save daily pep (Pro)
                  </ThemedText>
                </TouchableOpacity>
              )}
            </View>
          )}
        </Pressable>

        {/* Primary CTA card to reveal Custom Pep */}
        {!showCustomPep && (
          <Pressable
            onPress={() => setShowCustomPep(true)}
            style={({ pressed }) => [
              styles.customPepCtaCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
              pressed && { opacity: 0.9 },
            ]}>
            <View style={styles.customPepCtaContent}>
              <View style={{ flex: 1 }}>
                <ThemedText style={[styles.customPepCtaTitle, { color: theme.text }]}>
                  Need something specific?
                </ThemedText>
                <ThemedText style={[styles.customPepCtaSubtitle, { color: theme.mutedText }]}>
                  Create a custom pep tailored to today&apos;s challenge.
                </ThemedText>
              </View>
              <View style={[styles.customPepCtaPill, { backgroundColor: theme.accentWarm }]}>
                <ThemedText style={[styles.customPepCtaPillText, { color: theme.background }]}>
                  Create a custom pep
                </ThemedText>
              </View>
            </View>
          </Pressable>
        )}

        {/* Custom Pep Card - Conditionally rendered */}
        {showCustomPep && (
          <Animated.View
            ref={customPepRef}
            style={[
              styles.card,
              {
                backgroundColor: theme.surface,
                opacity: fadeAnim,
                transform: [{ translateY: translateYAnim }],
              },
            ]}>
            <ThemedText style={[styles.cardTitle, { color: theme.text }]}>What do you need to do today?</ThemedText>

            {/* Intent multi-select */}
            <View style={styles.intentSection}>
              <ThemedText style={[styles.intentLabel, { color: theme.mutedText }]}>Intent</ThemedText>
              <View style={styles.intentChipRow}>
                {INTENT_OPTIONS.map((opt) => {
                  const selected = selectedIntents.includes(opt.value);
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => {
                        if (status === 'loading' || dailyIsLoading) return;
                        setSelectedIntents((prev) =>
                          prev.includes(opt.value)
                            ? prev.filter((v) => v !== opt.value)
                            : [...prev, opt.value]
                        );
                      }}
                      style={[
                        styles.intentChip,
                        {
                          backgroundColor: selected ? theme.accentWarmMuted : theme.surfaceSoft,
                          borderColor: selected ? theme.accentWarm : theme.border,
                        },
                      ]}>
                      <ThemedText
                        style={[
                          styles.intentChipText,
                          { color: selected ? theme.accentWarm : theme.text },
                        ]}>
                        {opt.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
              {selectedIntents.includes('Other') && (
                <TextInput
                  style={[
                    styles.intentOtherInput,
                    { color: theme.text, backgroundColor: theme.surfaceSoft, borderColor: theme.border },
                  ]}
                  placeholder="Describe your intent…"
                  placeholderTextColor={theme.mutedText}
                  value={intentOther}
                  onChangeText={setIntentOther}
                  editable={status !== 'loading' && !dailyIsLoading}
                  maxLength={120}
                />
              )}
            </View>

            <ThemedText style={[styles.helperText, { color: theme.mutedText }]}>
              More detail = more personal pep.
            </ThemedText>

            {/* Main Input - Always visible */}
            <TextInput
              ref={textInputRef}
              style={[
                styles.cardInput,
                {
                  color: theme.text,
                  backgroundColor: theme.surfaceSoft,
                },
                (status === 'loading' || dailyIsLoading) && styles.inputDisabled,
              ]}
              placeholder="I don't want to go to the gym and I keep making excuses."
              placeholderTextColor={theme.mutedText}
              value={goalText}
              onChangeText={setGoalText}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              editable={status !== 'loading' && !dailyIsLoading}
              maxLength={maxChars}
              onFocus={() => {
                setTimeout(() => {
                  textInputRef.current?.measureLayout(
                    scrollViewRef.current as any,
                    (x, y) => {
                      scrollViewRef.current?.scrollTo({ y: y - 100, animated: true });
                    },
                    () => {}
                  );
                }, 100);
              }}
            />

            <ThemedText style={[styles.charCount, { color: theme.mutedText }]}>
              {goalText.length}/{maxChars} · {maxChars - goalText.length} left
            </ThemedText>

            {/* "Dial it in" expandable panel */}
            {goalText.trim().length > 0 && (
              <View style={styles.dialItInContainer}>
                <Pressable
                  style={({ pressed }) => [
                    styles.dialItInButton,
                    {
                      backgroundColor: theme.surfaceSoft,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                  onPress={() => setDialItInExpanded(!dialItInExpanded)}>
                  <View style={styles.dialItInHeaderLeft}>
                    <ThemedText style={[styles.dialItInButtonText, { color: theme.text }]}>
                      Dial it in
                    </ThemedText>
                    <ThemedText style={[styles.dialItInSummary, { color: theme.mutedText }]}>
                      {getDialItInSummary()}
                    </ThemedText>
                  </View>
                  <View style={styles.dialItInHeaderRight}>
                    {dialItInExpanded && (
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation();
                          setDialItInExpanded(false);
                        }}>
                        <ThemedText style={[styles.dialItInDoneText, { color: theme.mutedText }]}>
                          Done
                        </ThemedText>
                      </Pressable>
                    )}
                    <ThemedText
                      style={[
                        styles.dialItInChevron,
                        { color: theme.mutedText },
                        dialItInExpanded && { transform: [{ rotate: '90deg' }] },
                      ]}>
                      ▸
                    </ThemedText>
                  </View>
                </Pressable>

                {/* Expandable content */}
                <Animated.View
                  style={[
                    styles.dialItInContent,
                    {
                      maxHeight: dialItInHeight.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, 2000],
                      }),
                      opacity: dialItInOpacity,
                    },
                  ]}>
                  {dialItInExpanded && (
                    <View>
                      {/* Honesty Scale */}
                      <View style={styles.honestyContainer}>
                        <ThemedText style={[styles.sectionLabel, { color: theme.mutedText }]}>
                          Intensity
                        </ThemedText>
                        
                        {/* Label row */}
                        <View style={styles.honestyLabelRow}>
                          <ThemedText style={[styles.honestyEndLabel, { color: theme.mutedText }]}>
                            Easy
                          </ThemedText>
                          <ThemedText style={[styles.honestyEndLabel, { color: theme.mutedText }]}>
                            No excuses
                          </ThemedText>
                        </View>
                        
                        {/* Segmented intensity bar */}
                        <View style={styles.honestyBarContainer}>
                          {[1, 2, 3, 4, 5].map((level) => (
                            <Pressable
                              key={level}
                              style={({ pressed }) => [
                                styles.honestySegment,
                                {
                                  backgroundColor: honestyLevel >= level 
                                    ? theme.accentWarm 
                                    : theme.surfaceSoft,
                                  opacity: pressed ? 0.7 : 1,
                                },
                              ]}
                              onPress={() => {
                                if (!(status === 'loading' || dailyIsLoading)) {
                                  setHonestyLevel(level as HonestyLevel);
                                  setDefaultHonestyLevel(level).catch(() => {});
                                }
                              }}
                              disabled={status === 'loading' || dailyIsLoading}>
                            </Pressable>
                          ))}
                        </View>
                        
                        {/* Selected label */}
                        <ThemedText style={[styles.honestySelectedLabel, { color: theme.text }]}>
                          {HONESTY_LEVELS[honestyLevel].label}
                        </ThemedText>
                      </View>

                      {/* Voice Profile Selector - Pro/Flow only */}
                      {!isFreeTier && (
                        <View style={styles.voiceContainer}>
                          <ThemedText style={[styles.sectionLabel, { color: theme.mutedText }]}>
                            Voice Profile
                          </ThemedText>
                          <View style={styles.voiceRowContainer}>
                            {AVAILABLE_VOICE_PROFILES.map((profileId) => {
                              const isSelected = selectedVoiceProfileId === profileId;
                              const isLoading = previewLoadingId === profileId;
                              const isDisabled = status === 'loading' || dailyIsLoading || (previewLoadingId !== null && !isLoading);
                              const profile = VOICE_PROFILES[profileId];
                              
                              return (
                                <Pressable
                                  key={profileId}
                                  style={({ pressed }) => [
                                    styles.voiceRow,
                                    {
                                      backgroundColor: isSelected ? theme.surfaceSoft : 'transparent',
                                      opacity: pressed ? 0.7 : 1,
                                      shadowColor: isSelected ? theme.shadow : 'transparent',
                                      shadowOffset: { width: 0, height: 2 },
                                      shadowOpacity: isSelected ? 0.2 : 0,
                                      shadowRadius: isSelected ? 4 : 0,
                                    },
                                  ]}
                                  onPress={() => handleVoiceProfileChange(profileId)}
                                  disabled={isDisabled}>
                                  {/* Selected indicator */}
                                  <View style={[
                                    styles.voiceSelectedIndicator,
                                    {
                                      backgroundColor: isSelected ? theme.accentWarm : 'transparent',
                                      borderColor: isSelected ? theme.accentWarm : theme.border,
                                    },
                                  ]} />
                                  
                                  {/* Label + Descriptor */}
                                  <View style={styles.voiceLabelContainer}>
                                    <ThemedText
                                      style={[
                                        styles.voiceRowLabel,
                                        {
                                          color: isSelected ? theme.text : theme.mutedText,
                                          fontWeight: isSelected ? '600' : '500',
                                        },
                                      ]}>
                                      {profile.label}
                                    </ThemedText>
                                    <ThemedText
                                      style={[
                                        styles.voiceRowDescriptor,
                                        {
                                          color: theme.mutedText,
                                        },
                                      ]}>
                                      {profile.descriptor}
                                    </ThemedText>
                                  </View>
                                  
                                  {/* Play button */}
                                  <Pressable
                                    style={({ pressed: buttonPressed }) => [
                                      styles.voicePreviewButton,
                                      {
                                        backgroundColor: theme.surfaceSoft,
                                        opacity: buttonPressed ? 0.7 : 1,
                                      },
                                    ]}
                                    onPress={(e) => {
                                      e.stopPropagation();
                                      handleVoicePreview(profileId);
                                    }}
                                    disabled={isDisabled || isLoading}>
                                    {isLoading ? (
                                      <ActivityIndicator size="small" color={theme.mutedText} />
                                    ) : (
                                      <ThemedText style={[styles.voicePreviewIcon, { color: theme.text }]}>
                                        ▶
                                      </ThemedText>
                                    )}
                                  </Pressable>
                                </Pressable>
                              );
                            })}
                          </View>
                          {previewError && (
                            <ThemedText style={[styles.voicePreviewError, { color: theme.error }]}>
                              {previewError}
        </ThemedText>
                          )}
                        </View>
                      )}

                      {/* Length Selector */}
                      <View style={styles.lengthContainer}>
                        <ThemedText style={[styles.sectionLabel, { color: theme.mutedText }]}>
                          Length
                        </ThemedText>
                        <View style={styles.lengthChipRow}>
                          {(() => {
                            const options = isFreeTier 
                              ? [30] 
                              : entitlement === 'flow' 
                              ? [30, 60, 90, 120, 180] 
                              : [30, 60, 90];
                            
                            return options.map((seconds) => (
                              <Pressable
                                key={seconds}
                                style={({ pressed }) => [
                                  styles.lengthChip,
                                  {
                                    backgroundColor: targetSeconds === seconds 
                                      ? theme.surfaceSoft 
                                      : 'rgba(255,255,255,0.03)',
                                    opacity: pressed ? 0.7 : 1,
                                  },
                                ]}
                                onPress={() => {
                                  if (!(status === 'loading' || dailyIsLoading)) {
                                    setTargetSeconds(seconds);
                                  }
                                }}
                                disabled={status === 'loading' || dailyIsLoading}>
                                <ThemedText
                                  style={[
                                    styles.lengthChipText,
                                    {
                                      color: targetSeconds === seconds 
                                        ? theme.text 
                                        : theme.mutedText,
                                      fontWeight: targetSeconds === seconds ? '600' : '500',
                                    },
                                  ]}>
                                  {formatLengthChipLabel(seconds)}
                                </ThemedText>
                              </Pressable>
                            ));
                          })()}
                        </View>
                        <ThemedText style={[styles.estimatedDurationLabel, { color: theme.mutedText }]}>
                          Estimated duration: ~{formatDurationSummary(targetSeconds)}
                        </ThemedText>
                      </View>

                      {/* Pro/Flow Outcome & Obstacle chips */}
                      {!isFreeTier && (
                        <>
                          {/* Outcome chips */}
                          <ThemedText style={[styles.chipQuestion, { color: theme.mutedText }]}>
                            What outcome do you want today?
                          </ThemedText>
                          <View style={styles.chipRow}>
                            {PRO_OUTCOME_OPTIONS.map((option) => (
                              <TouchableOpacity
                                key={option}
                                activeOpacity={0.7}
                                style={[
                                  styles.chip,
                                  selectedOutcome === option && { backgroundColor: theme.surfaceSoft },
                                ]}
                                onPress={() => {
                                  setSelectedOutcome(option);
                                  setShowOutcomeOther(false);
                                }}>
                                <ThemedText
                                  style={[
                                    styles.chipText,
                                    { color: selectedOutcome === option ? theme.text : theme.mutedText },
                                    selectedOutcome === option && styles.chipTextSelected,
                                  ]}>
                                  {option}
                                </ThemedText>
                              </TouchableOpacity>
                            ))}
                            <TouchableOpacity
                              activeOpacity={0.7}
                              style={[
                                styles.chip,
                                selectedOutcome === 'other' && { backgroundColor: theme.surfaceSoft },
                              ]}
                              onPress={() => {
                                setSelectedOutcome('other');
                                setShowOutcomeOther(true);
                              }}>
                              <ThemedText
                                style={[
                                  styles.chipText,
                                  { color: selectedOutcome === 'other' ? theme.text : theme.mutedText },
                                  selectedOutcome === 'other' && styles.chipTextSelected,
                                ]}>
                                Other…
                              </ThemedText>
                            </TouchableOpacity>
                            <TouchableOpacity
                              activeOpacity={0.7}
                              style={[
                                styles.chip,
                                selectedOutcome === 'skip' && { backgroundColor: theme.surfaceSoft },
                              ]}
                              onPress={() => {
                                setSelectedOutcome('skip');
                                setShowOutcomeOther(false);
                              }}>
                              <ThemedText
                                style={[
                                  styles.chipText,
                                  { color: selectedOutcome === 'skip' ? theme.text : theme.mutedText },
                                  selectedOutcome === 'skip' && styles.chipTextSelected,
                                ]}>
                                Skip
                              </ThemedText>
                            </TouchableOpacity>
                          </View>
                          {showOutcomeOther && (
                            <TextInput
                              style={[
                                styles.chipOtherInput,
                                {
                                  color: theme.text,
                                  backgroundColor: theme.surfaceSoft,
                                },
                              ]}
                              placeholder="Enter your desired outcome"
                              placeholderTextColor={theme.mutedText}
                              value={outcomeOther}
                              onChangeText={setOutcomeOther}
                              maxLength={100}
                              editable={status !== 'loading' && !dailyIsLoading}
                            />
                          )}

                          {/* Obstacle chips */}
                          <ThemedText style={[styles.chipQuestion, { color: theme.mutedText }]}>
                            What's the real obstacle?
                          </ThemedText>
                          <View style={styles.chipRow}>
                            {PRO_OBSTACLE_OPTIONS.map((option) => (
                              <TouchableOpacity
                                key={option}
                                activeOpacity={0.7}
                                style={[
                                  styles.chip,
                                  selectedObstacle === option && { backgroundColor: theme.surfaceSoft },
                                ]}
                                onPress={() => {
                                  setSelectedObstacle(option);
                                  setShowObstacleOther(false);
                                }}>
                                <ThemedText
                                  style={[
                                    styles.chipText,
                                    { color: selectedObstacle === option ? theme.text : theme.mutedText },
                                    selectedObstacle === option && styles.chipTextSelected,
                                  ]}>
                                  {option}
                                </ThemedText>
                              </TouchableOpacity>
                            ))}
                            <TouchableOpacity
                              activeOpacity={0.7}
                              style={[
                                styles.chip,
                                selectedObstacle === 'other' && { backgroundColor: theme.surfaceSoft },
                              ]}
                              onPress={() => {
                                setSelectedObstacle('other');
                                setShowObstacleOther(true);
                              }}>
                              <ThemedText
                                style={[
                                  styles.chipText,
                                  { color: selectedObstacle === 'other' ? theme.text : theme.mutedText },
                                  selectedObstacle === 'other' && styles.chipTextSelected,
                                ]}>
                                Other…
                              </ThemedText>
                            </TouchableOpacity>
                            <TouchableOpacity
                              activeOpacity={0.7}
                              style={[
                                styles.chip,
                                selectedObstacle === 'skip' && { backgroundColor: theme.surfaceSoft },
                              ]}
                              onPress={() => {
                                setSelectedObstacle('skip');
                                setShowObstacleOther(false);
                              }}>
                              <ThemedText
                                style={[
                                  styles.chipText,
                                  { color: selectedObstacle === 'skip' ? theme.text : theme.mutedText },
                                  selectedObstacle === 'skip' && styles.chipTextSelected,
                                ]}>
                                Skip
                              </ThemedText>
                            </TouchableOpacity>
                          </View>
                          {showObstacleOther && (
                            <TextInput
                              style={[
                                styles.chipOtherInput,
                                {
                                  color: theme.text,
                                  backgroundColor: theme.surfaceSoft,
                                },
                              ]}
                              placeholder="Enter the real obstacle"
                              placeholderTextColor={theme.mutedText}
                              value={obstacleOther}
                              onChangeText={setObstacleOther}
                              maxLength={100}
                              editable={status !== 'loading' && !dailyIsLoading}
                            />
                          )}
                        </>
                      )}
                    </View>
                  )}
                </Animated.View>
              </View>
            )}

            {/* Primary CTA Button - Always at bottom */}
            <TouchableOpacity
              activeOpacity={0.7}
              style={[
                styles.cardButton,
                { 
                  backgroundColor: theme.accentWarm,
                  shadowColor: theme.accentWarm,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                },
                (isFreeTier 
                  ? isGenerateDisabled 
                  : (status === 'loading' || dailyIsLoading || !goalText.trim() || !selectedOutcome || !selectedObstacle)) && styles.buttonDisabled,
              ]}
              onPress={handleGenerate}
              disabled={isFreeTier 
                ? isGenerateDisabled 
                : (status === 'loading' || dailyIsLoading || !goalText.trim() || !selectedOutcome || !selectedObstacle)}>
              {status === 'loading' ? (
                <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>
                  Generating your pep…
                </ThemedText>
              ) : (
                <ThemedText style={[styles.cardButtonText, { color: theme.background }]}>
                  {isFreeTier ? 'Tell me straight' : 'Generate Pep'}
        </ThemedText>
              )}
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Progress Status / Intentional Loading Experience */}
        {(status === 'loading' || dailyIsLoading) && (
          <View style={[styles.progressContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <ThemedText style={[styles.progressText, { color: theme.text, fontWeight: '600' }]}>
              {dailyIsLoading ? 'Daily Pep is loading…' : 'Your pep is on its way'}
            </ThemedText>
            <ThemedText style={[styles.progressText, { color: theme.mutedText }]}>
              {dailyIsLoading
                ? 'Getting it ready…'
                : showAlmostReady
                  ? 'Almost ready…'
                  : loadingPhase === 'voicing'
                    ? 'Building your coach’s voice…'
                    : 'Writing your pep…'}
            </ThemedText>
            {!dailyIsLoading && (
              <ThemedText style={[styles.progressText, { color: theme.mutedText, marginTop: 4 }]}>
                {`“${LOADING_QUOTES[loadingQuoteIndex]}”`}
              </ThemedText>
            )}
            {!dailyIsLoading && status === 'loading' && (
              <ThemedText style={[styles.progressHint, { color: theme.mutedText }]}>
                Longer peps can take a bit to generate, but you&apos;ll be able to replay them instantly from your Library.
              </ThemedText>
            )}
          </View>
        )}

        {/* Error Message + Retry or Upgrade */}
        {status === 'error' && errorMessage && (
          <View style={[styles.errorContainer, { backgroundColor: theme.surface, borderColor: theme.error }]}>
            <ThemedText style={[styles.errorText, { color: theme.error }]}>⚠️ {errorMessage}</ThemedText>
            {errorMessage.includes('limit') && !hasUnlimitedCustomPeps ? (
              <TouchableOpacity
                activeOpacity={0.7}
                style={[styles.secondaryButton, { borderColor: theme.accentWarm, marginTop: 12 }]}
                onPress={() => {
                  setErrorMessage('');
                  setStatus('idle');
                  router.push('/paywall');
                }}>
                <ThemedText style={[styles.secondaryButtonText, { color: theme.accentWarm }]}>Upgrade</ThemedText>
              </TouchableOpacity>
            ) : errorMessage.includes('limit') ? null : (
              <TouchableOpacity
                activeOpacity={0.7}
                style={[styles.secondaryButton, { borderColor: theme.accentWarm, marginTop: 12 }]}
                onPress={() => {
                  setErrorMessage('');
                  setStatus('idle');
                  handleGenerate();
                }}>
                <ThemedText style={[styles.secondaryButtonText, { color: theme.accentWarm }]}>Retry</ThemedText>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Refusal (guardrail redirect) - show script as pep-style message + Try again */}
        {status === 'refused' && currentScriptText && showCustomPep && (
          <Animated.View
            style={[
              styles.refusalCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
              { opacity: fadeAnim, transform: [{ translateY: translateYAnim }] },
            ]}>
            <ThemedText style={[styles.refusalScript, { color: theme.text }]}>{currentScriptText}</ThemedText>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.refusalButton, { backgroundColor: theme.accentWarmMuted }]}
              onPress={() => {
                setStatus('idle');
                setCurrentScriptText('');
              }}>
              <ThemedText style={[styles.refusalButtonText, { color: theme.accentWarm }]}>Try again</ThemedText>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Audio Controls (for custom pep) - Only show when ready and not playing daily */}
        {status === 'ready' && audioUri && showCustomPep && (
          <Animated.View
            style={[
              styles.audioControls,
              {
                opacity: fadeAnim,
                transform: [{ translateY: translateYAnim }],
              },
            ]}>
            {isCustomPlaying ? (
              <>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                  onPress={handlePause}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Pause</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder, marginLeft: 8 }]}
                  onPress={handleStop}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Stop</ThemedText>
                </TouchableOpacity>
              </>
            ) : isCustomPaused ? (
              <>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                  onPress={handleResume}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Resume</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.secondaryButton, { borderColor: theme.buttonBorder, marginLeft: 8 }]}
                  onPress={handleStop}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Stop</ThemedText>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                activeOpacity={0.7}
                style={[
                  styles.secondaryButton,
                  { borderColor: theme.buttonBorder },
                  isPlayDisabled && styles.buttonDisabled,
                ]}
                onPress={handlePlay}
                disabled={isPlayDisabled}>
                <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Play</ThemedText>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {/* Read Toggle and Save Button / Upsell for Custom Pep */}
        {showCustomPep && (
          <Animated.View
            style={{
              opacity: fadeAnim,
              transform: [{ translateY: translateYAnim }],
            }}>
            {/* Read options (Custom Pep only) */}
            {canRead && (
              <>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[
                    styles.secondaryButton,
                    { borderColor: theme.buttonBorder, marginBottom: 8 },
                    !currentScriptText && styles.buttonDisabled,
                  ]}
                  onPress={() => currentScriptText && handleOpenReadingMode(currentScriptText, 'Custom Pep')}
                  disabled={!currentScriptText}>
                  <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                    {currentScriptText ? 'Read now' : 'Read when ready…'}
                  </ThemedText>
                </TouchableOpacity>
                {currentScriptText && (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[
                      styles.secondaryButton,
                      { borderColor: theme.buttonBorder, marginBottom: 8 },
                    ]}
                    onPress={handleDeviceRead}>
                    <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                      Read with device voice
                    </ThemedText>
                  </TouchableOpacity>
                )}
              </>
            )}

            {/* Save / Continue are only relevant once pep is fully generated */}
            {status === 'ready' && audioUri && currentScriptText && (
              <>
                {entitlement === 'free' ? (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                    onPress={() => router.push('/paywall')}>
                    <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                      💾 Save (Pro)
                    </ThemedText>
                  </TouchableOpacity>
                ) : savedCustomId ? (
                  <View style={styles.saveRow}>
                    <ThemedText style={[styles.savedLabel, { color: theme.mutedText }]}>Saved ✓</ThemedText>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                      onPress={handleUnsaveCustom}>
                      <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>Unsave</ThemedText>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.secondaryButton, { borderColor: theme.buttonBorder }]}
                    onPress={handleSave}>
                    <ThemedText style={[styles.secondaryButtonText, { color: theme.text }]}>
                      💾 Save to Library
                    </ThemedText>
                  </TouchableOpacity>
                )}
                {isFlow && (
                  <View style={{ marginTop: 8 }}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={[
                        styles.continueSessionButton,
                        { backgroundColor: theme.accentWarmMuted, borderColor: theme.accentWarm, opacity: 0.6 },
                      ]}
                      disabled>
                      <ThemedText style={[styles.continueSessionText, { color: theme.accentWarm }]}>
                        ▶ Continue Session
                      </ThemedText>
                      <ThemedText style={[styles.continueSessionText, { color: theme.mutedText, fontSize: 12 }]}>
                        Coming soon
                      </ThemedText>
                    </TouchableOpacity>
                    <ThemedText style={[styles.progressHint, { color: theme.mutedText }]}>
                      Coming soon: chain another pep that picks up where this one left off.
                    </ThemedText>
                  </View>
                )}
              </>
            )}
          </Animated.View>
        )}

        {/* Flow Conversion Prompt - Inline Banner */}
        {showFlowPrompt && !isFlow && (
          <View
            style={[
              styles.flowPromptBanner,
              {
                backgroundColor: theme.surfaceSoft,
                borderColor: theme.border,
              },
            ]}>
            <View style={styles.flowPromptContent}>
              <ThemedText style={[styles.flowPromptText, { color: theme.text }]}>
                {flowPromptMessage}
              </ThemedText>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  setShowFlowPrompt(false);
                  router.push('/paywall');
                }}>
                <ThemedText style={[styles.flowPromptLink, { color: theme.accent }]}>
                  Learn more
                </ThemedText>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.flowPromptClose}
              onPress={() => setShowFlowPrompt(false)}>
              <ThemedText style={[styles.flowPromptCloseText, { color: theme.mutedText }]}>
                ×
              </ThemedText>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Reading Mode Modal */}
      <Modal
        visible={showReadingMode}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleCloseReadingMode}>
        <View style={[styles.readingModeContainer, { backgroundColor: theme.background }]}>
          {/* Header */}
          <View style={[styles.readingModeHeader, { borderBottomColor: theme.border }]}>
            <ThemedText style={[styles.readingModeTitle, { color: theme.text }]}>
              {readingModeTitle}
            </ThemedText>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.readingModeCloseButton, { borderColor: theme.buttonBorder }]}
              onPress={handleCloseReadingMode}>
              <ThemedText style={[styles.readingModeCloseText, { color: theme.text }]}>
                Close
              </ThemedText>
            </TouchableOpacity>
          </View>

          {/* Script Text */}
          <ScrollView
            style={styles.readingModeScroll}
            contentContainerStyle={styles.readingModeContent}>
            <ThemedText style={[styles.readingModeText, { color: theme.text }]}>
              {readingModeScript}
            </ThemedText>
          </ScrollView>
        </View>
      </Modal>

      {/* Feedback after pep finishes (disabled in production; modal left here commented for future use) */}
      {false && (
        <Modal
          visible={false}
          transparent
          animationType="fade"
          onRequestClose={() => {}}>
          <View />
        </Modal>
      )}
      </ThemedView>
    </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  ambientLight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
    zIndex: 0,
  },
  scrollView: {
    flex: 1,
    zIndex: 1,
  },
  content: {
    padding: 20,
    gap: 28,
    paddingBottom: 160, // Extra padding for keyboard
  },
  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  headerLeft: {
    flex: 1,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1,
  },
  headerTextBlock: {
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.5,
    lineHeight: 40,
    paddingTop: 4,
  },
  headerTagline: {
    fontSize: 16,
    marginTop: 2,
  },
  dialItInHeaderLeft: {
    flexDirection: 'column',
    flexShrink: 1,
    gap: 4,
  },
  dialItInHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dialItInChevron: {
    fontSize: 14,
  },
  dialItInDoneText: {
    fontSize: 13,
    fontWeight: '500',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
  statusPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  streakBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  streakEmoji: {
    fontSize: 14,
  },
  streakCount: {
    fontSize: 14,
    fontWeight: '700',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  habitRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  refreshIconButton: {
    paddingHorizontal: 4,
  },
  refreshIcon: {
    fontSize: 16,
  },
  habitChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  habitChipText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  headerDebug: {
    fontSize: 12,
    marginTop: 4,
  },
  headerDivider: {
    height: 1,
    borderRadius: 999,
    marginHorizontal: 20,
    marginBottom: 16,
  },
  // Cards
  card: {
    borderRadius: 22,
    padding: 26,
    gap: 20,
    marginBottom: 20,
    backgroundColor: theme.surface,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  cardSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  intentSection: {
    marginTop: 12,
    gap: 8,
  },
  intentLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  intentChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  intentChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  intentChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  intentOtherInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    marginTop: 4,
  },
  helperText: {
    fontSize: 13,
    marginTop: 8,
    lineHeight: 18,
  },
  // Daily Pep Card
  dailyPepContent: {
    gap: 12,
    marginTop: 4,
  },
  dailyPepTopicLabel: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  dailyPepTopic: {
    fontSize: 24,
    fontWeight: '600',
  },
  dailyPepQuote: {
    fontSize: 17,
    fontStyle: 'italic',
    lineHeight: 26,
  },
  dailyPepPlaceholder: {
    fontSize: 14,
    fontStyle: 'italic',
    marginTop: 4,
  },
  // Section Labels
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  // Custom Pep Card - Honesty Scale
  honestyContainer: {
    marginTop: 20,
    gap: 12,
  },
  honestyLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  honestyEndLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  honestyBarContainer: {
    flexDirection: 'row',
    gap: 4,
    height: 48,
    marginBottom: 12,
  },
  honestySegment: {
    flex: 1,
    height: '100%',
    borderRadius: 8,
  },
  honestySelectedLabel: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  cardInput: {
    borderRadius: 16,
    padding: 20,
    minHeight: 100,
    maxHeight: 120,
    fontSize: 16,
    marginTop: 16,
    backgroundColor: theme.surfaceSoft,
  },
  charCount: {
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
  },
  // Buttons
  cardButton: {
    width: '100%',
    padding: 16,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    marginTop: 24,
    flexDirection: 'row',
    backgroundColor: theme.accent,
    shadowColor: theme.accentWarm,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  cardButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    padding: 16,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderWidth: 1,
    marginTop: 16,
    backgroundColor: 'transparent',
  },
  continueSessionButton: {
    padding: 16,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderWidth: 2,
    marginTop: 12,
  },
  continueSessionText: {
    fontSize: 16,
    fontWeight: '600',
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
  },
  savedLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  customPepCtaCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
  },
  customPepCtaContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  customPepCtaTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  customPepCtaSubtitle: {
    fontSize: 13,
    lineHeight: 20,
  },
  customPepCtaPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customPepCtaPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  revealLink: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  revealLinkText: {
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  // Status
  progressContainer: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 4,
    padding: 18,
    borderRadius: 18,
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  progressText: {
    fontSize: 14,
  },
   progressHint: {
    fontSize: 12,
    marginTop: 4,
   },
  errorContainer: {
    padding: 18,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 12,
  },
  errorText: {
    fontSize: 14,
    textAlign: 'center',
  },
  refusalCard: {
    padding: 20,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 16,
    gap: 16,
  },
  refusalScript: {
    fontSize: 16,
    lineHeight: 24,
  },
  refusalButton: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 24,
    alignSelf: 'flex-start',
  },
  refusalButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  debugText: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  // Audio Controls
  audioControls: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  saveSection: {
    marginTop: 12,
  },
  // "Dial it in" expandable panel
  dialItInContainer: {
    marginTop: 20,
    gap: 12,
  },
  dialItInButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    marginBottom: 8,
  },
  dialItInButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  dialItInSummary: {
    fontSize: 13,
    fontWeight: '500',
  },
  dialItInContent: {
    overflow: 'hidden',
    gap: 20,
  },
  // Pro structured intake styles
  proStepContainer: {
    marginTop: 20,
    gap: 16,
  },
  proStepLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  chipQuestion: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
    marginBottom: 10,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  chipTextSelected: {
    fontWeight: '600',
  },
  chipOtherInput: {
    borderRadius: 14,
    padding: 14,
    fontSize: 14,
    marginTop: 10,
    minHeight: 44,
    backgroundColor: theme.surfaceSoft,
  },
  upsellRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upsellText: {
    fontSize: 13,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  // Reading Mode
  readingModeContainer: {
    flex: 1,
  },
  readingModeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60,
    borderBottomWidth: 1,
  },
  readingModeTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  readingModeCloseButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  readingModeCloseText: {
    fontSize: 16,
    fontWeight: '600',
  },
  readingModeScroll: {
    flex: 1,
  },
  readingModeContent: {
    padding: 24,
  },
  readingModeText: {
    fontSize: 18,
    lineHeight: 32,
    letterSpacing: 0.3,
  },
  // Voice Selector
  voiceContainer: {
    marginTop: 20,
    marginBottom: 8,
  },
  voiceLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  voiceRowContainer: {
    gap: 10,
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 16,
    minHeight: 64,
    gap: 14,
  },
  voiceSelectedIndicator: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  voiceLabelContainer: {
    flex: 1,
    gap: 2,
  },
  voiceRowLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  voiceRowDescriptor: {
    fontSize: 12,
    fontWeight: '400',
  },
  voicePreviewButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceSoft,
  },
  voicePreviewIcon: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 2,
  },
  voicePreviewError: {
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  // Length Selector
  lengthContainer: {
    marginTop: 20,
    marginBottom: 8,
  },
  lengthLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  lengthChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  estimatedDurationLabel: {
    fontSize: 12,
    marginTop: 8,
  },
  lengthChip: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 999,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  lengthChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // Flow Conversion Prompt
  flowPromptBanner: {
    marginHorizontal: 20,
    marginTop: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flowPromptContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  flowPromptText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  flowPromptLink: {
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  flowPromptClose: {
    padding: 4,
    marginLeft: 8,
  },
  flowPromptCloseText: {
    fontSize: 20,
    lineHeight: 20,
  },
  feedbackOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
    paddingBottom: 40,
    paddingHorizontal: 20,
  },
  feedbackCard: {
    borderRadius: 20,
    padding: 24,
    gap: 16,
  },
  feedbackTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  feedbackLabel: {
    fontSize: 14,
    marginTop: 4,
  },
  feedbackTextInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  feedbackSkipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  feedbackSkipLabel: {
    fontSize: 14,
    flex: 1,
  },
  feedbackButtons: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  feedbackButton: {
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 24,
    minWidth: 120,
    alignItems: 'center',
    borderWidth: 1,
  },
  feedbackButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  feedbackReasons: {
    gap: 10,
  },
  feedbackReasonButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  feedbackReasonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
