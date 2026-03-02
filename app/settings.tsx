import { StyleSheet, TouchableOpacity, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';

import { ThemedText } from '@/components/themed-text';
import { useUser } from '@/contexts/UserContext';
import { pepTheme } from '@/constants/pep-theme';
import { getDefaultHonestyLevel, setDefaultHonestyLevel } from '@/services/PepFeedback';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const theme = pepTheme;

type VoiceProfileId = 'coach_m' | 'coach_f' | 'calm_m' | 'calm_f';
const VOICE_LABELS: Record<VoiceProfileId, string> = {
  coach_m: 'Coach (Male)',
  coach_f: 'Coach (Female)',
  calm_m: 'Calm (Male)',
  calm_f: 'Calm (Female)',
};
const VOICE_IDS: VoiceProfileId[] = ['coach_m', 'coach_f', 'calm_m', 'calm_f'];

const HONESTY_LABELS: Record<number, string> = {
  1: 'Gentle',
  2: 'Supportive',
  3: 'Direct',
  4: 'Firm',
  5: 'Intense',
};

export default function PlaybackPreferencesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { entitlement } = useUser();
  const [defaultVoice, setDefaultVoice] = useState<VoiceProfileId>('coach_m');
  const [defaultIntensity, setDefaultIntensity] = useState<number>(3);

  const isProOrFlow = entitlement === 'pro' || entitlement === 'flow';

  useEffect(() => {
    getDefaultHonestyLevel().then(setDefaultIntensity);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem('selectedVoiceProfileId').then((id) => {
      if (id && VOICE_IDS.includes(id as VoiceProfileId)) setDefaultVoice(id as VoiceProfileId);
    });
  }, []);

  const handleVoiceSelect = async (id: VoiceProfileId) => {
    if (!isProOrFlow) return;
    setDefaultVoice(id);
    await AsyncStorage.setItem('selectedVoiceProfileId', id);
  };

  const handleIntensitySelect = async (level: number) => {
    if (!isProOrFlow) return;
    setDefaultIntensity(level);
    await setDefaultHonestyLevel(level);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.backgroundTop }]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 20) + 12 }]}
        showsVerticalScrollIndicator={false}>
        <ThemedText type="title" style={[styles.pageTitle, { color: theme.text }]}>
          Playback Preferences
        </ThemedText>

        {!isProOrFlow ? (
          <View style={[styles.lockedCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <ThemedText style={[styles.lockedTitle, { color: theme.text }]}>Pro+ feature</ThemedText>
            <ThemedText style={[styles.lockedSummary, { color: theme.mutedText }]}>
              Set a default voice and intensity for your peps. Upgrade to customize.
            </ThemedText>
            <TouchableOpacity
              style={[styles.upgradeButton, { backgroundColor: theme.accentWarm }]}
              onPress={() => router.push('/paywall')}
              activeOpacity={0.9}>
              <ThemedText style={[styles.upgradeButtonText, { color: theme.background }]}>Upgrade</ThemedText>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <ThemedText style={[styles.rowHint, { color: theme.mutedText }]}>Default voice</ThemedText>
            <View style={styles.chipRow}>
              {VOICE_IDS.map((id) => (
                <TouchableOpacity
                  key={id}
                  style={[
                    styles.chip,
                    { borderColor: theme.border },
                    defaultVoice === id && { backgroundColor: theme.accentWarm, borderColor: theme.accentWarm },
                  ]}
                  onPress={() => handleVoiceSelect(id)}>
                  <ThemedText
                    style={[
                      styles.chipText,
                      { color: theme.mutedText },
                      defaultVoice === id && { color: theme.background },
                    ]}>
                    {VOICE_LABELS[id]}
                  </ThemedText>
                </TouchableOpacity>
              ))}
            </View>
            <ThemedText style={[styles.rowHint, { color: theme.mutedText, marginTop: 16 }]}>Default intensity</ThemedText>
            <View style={styles.chipRow}>
              {[1, 2, 3, 4, 5].map((level) => (
                <TouchableOpacity
                  key={level}
                  style={[
                    styles.chip,
                    { borderColor: theme.border },
                    defaultIntensity === level && { backgroundColor: theme.accentWarm, borderColor: theme.accentWarm },
                  ]}
                  onPress={() => handleIntensitySelect(level)}>
                  <ThemedText
                    style={[
                      styles.chipText,
                      { color: theme.mutedText },
                      defaultIntensity === level && { color: theme.background },
                    ]}>
                    {HONESTY_LABELS[level]}
                  </ThemedText>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  pageTitle: { fontSize: 22, fontWeight: '700', marginBottom: 20 },
  sectionCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  lockedCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
  },
  lockedTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  lockedSummary: { fontSize: 15, lineHeight: 22, marginBottom: 20 },
  upgradeButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  upgradeButtonText: { fontSize: 16, fontWeight: '600' },
  rowHint: { fontSize: 13, marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  chipText: { fontSize: 14, fontWeight: '500' },
});
