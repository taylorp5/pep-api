import { useState, useEffect } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  View,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useUser } from '@/contexts/UserContext';
import { useThemeColor } from '@/hooks/use-theme-color';
import { pepTheme } from '@/constants/pep-theme';
import {
  purchasePro,
  purchaseFlow,
  restorePurchases,
  getOfferings,
  getProPackage,
  getFlowPackage,
  isRevenueCatConfigured,
  waitForRevenueCatReady,
  getRevenueCatStatus,
} from '@/services/subscription';

const PRO_FEATURES = [
  { icon: '✨', title: '5 custom peps per day', desc: 'Generate up to 5 custom peps daily' },
  { icon: '⏱️', title: '30–90 seconds', desc: 'Longer pep talks, up to 90 seconds' },
  { icon: '💾', title: 'Save to Library', desc: 'Save favorites and replay anytime' },
  { icon: '📖', title: 'Read mode', desc: 'View pep text anytime' },
  { icon: '🎤', title: 'Voice selection', desc: 'Choose from multiple voices' },
];

const FLOW_FEATURES = [
  { icon: '🔥', title: 'Unlimited custom peps', desc: 'No daily cap' },
  { icon: '⏱️', title: 'Deep sessions up to 3 min', desc: 'Up to 3 minutes each + Continue feature' },
  { icon: '⏭️', title: 'Continue Session', desc: 'Extend with progression and intensity' },
  { icon: '▶️', title: 'Playlist playback', desc: 'Play saved peps back-to-back in Library' },
  { icon: '🎯', title: 'All Pro features', desc: 'Save, Read, Voice — everything in Pro' },
  { icon: '📋', title: 'Personalized daily pep', desc: 'Coming soon' },
  { icon: '⏱️', title: 'Longer peps', desc: 'Coming soon' },
  { icon: '🎵', title: 'Background music', desc: 'Coming soon' },
];

export default function PaywallScreen() {
  const router = useRouter();
  const { entitlement, refreshEntitlement } = useUser();
  const theme = pepTheme;
  const tintColor = useThemeColor({}, 'tint');
  const [isPurchasingPro, setIsPurchasingPro] = useState(false);
  const [isPurchasingFlow, setIsPurchasingFlow] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [rcReady, setRcReady] = useState<boolean | null>(null);
  const [rcError, setRcError] = useState<string | null>(null);
  const [offeringsReady, setOfferingsReady] = useState(false);
  const [proAvailable, setProAvailable] = useState(false);
  const [flowAvailable, setFlowAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    waitForRevenueCatReady(5000).then((ready) => {
      if (cancelled) return;
      setRcReady(ready);
      if (!ready) {
        const { message } = getRevenueCatStatus();
        setRcError(message || 'Subscriptions not available.');
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!rcReady) return;
    let cancelled = false;
    getOfferings().then((offering) => {
      if (cancelled) return;
      setOfferingsReady(true);
      setProAvailable(!!getProPackage(offering));
      setFlowAvailable(!!getFlowPackage(offering));
    });
    return () => { cancelled = true; };
  }, [rcReady]);

  const handlePurchasePro = async () => {
    if (!isRevenueCatConfigured()) {
      const { message } = getRevenueCatStatus();
      Alert.alert('Subscriptions Not Available', message);
      return;
    }
    setIsPurchasingPro(true);
    try {
      await purchasePro();
      await refreshEntitlement();
      Alert.alert('Welcome to Pro', 'Pro is now active.', [{ text: 'OK', onPress: () => router.back() }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Purchase failed. Try again.';
      if (!msg.toLowerCase().includes('cancelled')) {
        Alert.alert('Purchase Failed', msg);
      }
    } finally {
      setIsPurchasingPro(false);
    }
  };

  const handlePurchaseFlow = async () => {
    if (!isRevenueCatConfigured()) {
      const { message } = getRevenueCatStatus();
      Alert.alert('Subscriptions Not Available', message);
      return;
    }
    setIsPurchasingFlow(true);
    try {
      await purchaseFlow();
      await refreshEntitlement();
      Alert.alert('Welcome to Flow', 'Flow is now active.', [{ text: 'OK', onPress: () => router.back() }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Purchase failed. Try again.';
      if (!msg.toLowerCase().includes('cancelled')) {
        Alert.alert('Purchase Failed', msg);
      }
    } finally {
      setIsPurchasingFlow(false);
    }
  };

  const handleRestore = async () => {
    if (!isRevenueCatConfigured()) {
      const { message } = getRevenueCatStatus();
      Alert.alert('Subscriptions Not Available', message);
      return;
    }
    setIsRestoring(true);
    try {
      await restorePurchases();
      await refreshEntitlement();
      Alert.alert(
        'Restore Completed',
        'If you had an active subscription, it should be restored. Close this screen to see your plan.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (e) {
      Alert.alert('Restore Failed', e instanceof Error ? e.message : 'Could not restore. Try again.');
    } finally {
      setIsRestoring(false);
    }
  };

  const isSubscribed = entitlement === 'pro' || entitlement === 'flow';

  if (isSubscribed) {
    return (
      <ThemedView style={[styles.container, { backgroundColor: theme.background }]}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ThemedText type="title" style={[styles.title, { color: theme.text }]}>
            You're {entitlement === 'flow' ? 'Flow' : 'Pro'} 🎉
          </ThemedText>
          <ThemedText style={[styles.subtitle, { color: theme.mutedText }]}>
            You have access to all {entitlement === 'flow' ? 'Flow' : 'Pro'} features.
          </ThemedText>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: tintColor }]}
            onPress={() => router.back()}>
            <ThemedText style={styles.primaryButtonText}>Continue</ThemedText>
          </TouchableOpacity>
        </ScrollView>
      </ThemedView>
    );
  }

  const rcNotReady = rcReady !== true;
  const showRcError = rcReady === false && rcError;

  return (
    <ThemedView style={[styles.container, { backgroundColor: theme.background }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <ThemedText type="title" style={[styles.title, { color: theme.text }]}>
          Upgrade
        </ThemedText>
        <ThemedText style={[styles.subtitle, { color: theme.mutedText }]}>
          Pro $5/mo · Flow $8/mo. Free trial may be available. Use Restore if you already subscribed.
        </ThemedText>

        {rcReady === null && (
          <View style={[styles.errorCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <ActivityIndicator size="small" color={theme.accentWarm} />
            <ThemedText style={[styles.errorText, { color: theme.mutedText }]}>Loading subscriptions…</ThemedText>
          </View>
        )}

        {showRcError && (
          <View style={[styles.errorCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <ThemedText style={[styles.errorTitle, { color: theme.text }]}>Subscriptions unavailable</ThemedText>
            <ThemedText style={[styles.errorText, { color: theme.mutedText }]}>{rcError}</ThemedText>
          </View>
        )}

        <View style={[styles.planCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <ThemedText type="subtitle" style={[styles.planName, { color: theme.text }]}>Pro</ThemedText>
          {PRO_FEATURES.map((f, i) => (
            <View key={i} style={styles.featureRow}>
              <View style={styles.featureLeft}>
                <ThemedText style={styles.featureIcon}>{f.icon}</ThemedText>
                <ThemedText style={[styles.featureTitle, { color: theme.text }]}>{f.title}</ThemedText>
              </View>
              <View style={styles.featureRight}>
                <ThemedText style={[styles.featureDesc, { color: theme.mutedText }]}>{f.desc}</ThemedText>
              </View>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: tintColor }]}
            onPress={handlePurchasePro}
            disabled={rcNotReady || isPurchasingPro || isPurchasingFlow || isRestoring || !offeringsReady}>
            {isPurchasingPro ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <ThemedText style={styles.primaryButtonText}>
                {offeringsReady && proAvailable ? 'Pro — $5/mo' : 'Pro (loading…)'}
              </ThemedText>
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.planCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <ThemedText type="subtitle" style={[styles.planName, { color: theme.text }]}>Flow</ThemedText>
          {FLOW_FEATURES.map((f, i) => (
            <View key={i} style={styles.featureRow}>
              <View style={styles.featureLeft}>
                <ThemedText style={styles.featureIcon}>{f.icon}</ThemedText>
                <ThemedText style={[styles.featureTitle, { color: theme.text }]}>{f.title}</ThemedText>
              </View>
              <View style={styles.featureRight}>
                <ThemedText style={[styles.featureDesc, { color: theme.mutedText }]}>{f.desc}</ThemedText>
              </View>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: theme.accentWarm }]}
            onPress={handlePurchaseFlow}
            disabled={rcNotReady || isPurchasingPro || isPurchasingFlow || isRestoring || !offeringsReady}>
            {isPurchasingFlow ? (
              <ActivityIndicator color={theme.accentWarm} />
            ) : (
              <ThemedText style={[styles.secondaryButtonText, { color: theme.accentWarm }]}>
                {offeringsReady && flowAvailable ? 'Flow — $8/mo' : 'Flow (loading…)'}
              </ThemedText>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.restoreButton}
          onPress={handleRestore}
          disabled={rcNotReady || isPurchasingPro || isPurchasingFlow || isRestoring}>
          {isRestoring ? (
            <ActivityIndicator size="small" color={tintColor} />
          ) : (
            <ThemedText style={[styles.restoreText, { color: tintColor }]}>Restore Purchases</ThemedText>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
          <ThemedText style={[styles.closeText, { color: theme.mutedText }]}>Maybe Later</ThemedText>
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  title: { marginTop: 16, marginBottom: 8, textAlign: 'center', lineHeight: 38 },
  subtitle: { fontSize: 15, textAlign: 'center', marginBottom: 24 },
  planCard: {
    padding: 18,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
  },
  planName: { marginBottom: 12 },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    gap: 12,
  },
  featureLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  featureIcon: { fontSize: 20, marginRight: 6 },
  featureTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  featureRight: {
    flex: 1,
  },
  featureDesc: { fontSize: 13, lineHeight: 18 },
  primaryButton: {
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    marginTop: 12,
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  secondaryButton: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    marginTop: 12,
  },
  secondaryButtonText: { fontSize: 17, fontWeight: '600' },
  restoreButton: { padding: 16, alignItems: 'center', marginTop: 8 },
  restoreText: { fontSize: 15, fontWeight: '500' },
  closeButton: { padding: 16, alignItems: 'center', marginTop: 8 },
  closeText: { fontSize: 15 },
  errorCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
    alignItems: 'center',
    gap: 8,
  },
  errorTitle: { fontSize: 16, fontWeight: '600' },
  errorText: { fontSize: 14, textAlign: 'center' },
});
