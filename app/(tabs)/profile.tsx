import {
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  View,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
  Linking,
  ToastAndroid,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect, useRef } from 'react';
import Constants from 'expo-constants';

import { ThemedText } from '@/components/themed-text';
import { useUser } from '@/contexts/UserContext';
import { pepTheme } from '@/constants/pep-theme';
import {
  restorePurchases,
  getDevModeEnabled,
  setDevModeEnabled,
  setDevEntitlementOverride,
  getRevenueCatStatus,
  isRevenueCatConfigured,
  getSupportInfo,
  type Entitlement,
} from '@/services/subscription';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const DEV_MODE_TAP_COUNT = 7;
const theme = pepTheme;
const SUPPORT_EMAIL = 'pep.app.helpdesk@gmail.com';

const PLAN_SUMMARIES: Record<Entitlement, string> = {
  free: '1 custom pep/day, 30s · Daily Pep replay',
  pro: '5 custom peps/day, 30–90s · Save, Read, Voices',
  flow: 'Deep sessions up to 3 min + Continue · Longer peps & music coming soon',
};

function openURL(url: string) {
  Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open link.'));
}

function openManageSubscription() {
  if (Platform.OS === 'android') {
    Linking.openURL('https://play.google.com/store/account/subscriptions').catch(() =>
      Alert.alert('Manage subscription', 'Open Play Store → Account → Subscriptions.')
    );
  } else if (Platform.OS === 'ios') {
    Linking.openURL('https://apps.apple.com/account/subscriptions').catch(() =>
      Alert.alert('Manage subscription', 'Open Settings → Apple ID → Subscriptions.')
    );
  }
}

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isPro, entitlement, refreshEntitlement } = useUser();
  const [isRestoring, setIsRestoring] = useState(false);
  const [isRefreshingSubscription, setIsRefreshingSubscription] = useState(false);
  const [devModeEnabled, setDevModeEnabledState] = useState(false);
  const [selectedEntitlement, setSelectedEntitlement] = useState<Entitlement>(entitlement);
  const [supportInfo, setSupportInfo] = useState<Awaited<ReturnType<typeof getSupportInfo>> | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const devModeTapCountRef = useRef(0);
  const devModeTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const buildNumber = Constants.nativeBuildVersion ?? '—';
  const privacyPolicyUrl =
    (Constants.expoConfig?.extra as { privacyPolicyUrl?: string } | undefined)?.privacyPolicyUrl ??
    'https://sites.google.com/view/pep-privacy/home';
  const termsOfServiceUrl =
    (Constants.expoConfig?.extra as { termsOfServiceUrl?: string } | undefined)?.termsOfServiceUrl ??
    'https://sites.google.com/view/peptermsofservice';

  useEffect(() => {
    const loadDevMode = async () => {
      const enabled = await getDevModeEnabled();
      setDevModeEnabledState(enabled);
      setSelectedEntitlement(entitlement);
    };
    loadDevMode();
  }, [entitlement]);

  useEffect(() => {
    getSupportInfo().then(setSupportInfo);
  }, [entitlement]);

  const handleRefreshSubscription = async () => {
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
  };

  const handlePlanCardPress = async () => {
    if (!__DEV__) return;
    devModeTapCountRef.current += 1;
    if (devModeTapTimeoutRef.current) clearTimeout(devModeTapTimeoutRef.current);
    if (devModeTapCountRef.current >= DEV_MODE_TAP_COUNT) {
      devModeTapCountRef.current = 0;
      const next = !devModeEnabled;
      await setDevModeEnabled(next);
      setDevModeEnabledState(next);
      Alert.alert('Dev mode', next ? 'Dev mode enabled. Entitlement override in Advanced.' : 'Dev mode disabled.');
    } else {
      devModeTapTimeoutRef.current = setTimeout(() => { devModeTapCountRef.current = 0; }, 2000);
    }
  };

  const handleRestorePurchases = async () => {
    if (!isRevenueCatConfigured()) {
      const { message } = getRevenueCatStatus();
      Alert.alert('Subscriptions Unavailable', message);
      return;
    }
    setIsRestoring(true);
    try {
      await restorePurchases();
      await refreshEntitlement();
      Alert.alert(isPro ? 'Success' : 'No Purchases Found', isPro ? 'Purchases restored!' : 'No active subscriptions found to restore.');
    } catch (error) {
      Alert.alert('Restore Failed', error instanceof Error ? error.message : 'Unable to restore purchases. Please try again.');
    } finally {
      setIsRestoring(false);
    }
  };

  const handleEntitlementChange = async (newEntitlement: Entitlement) => {
    setSelectedEntitlement(newEntitlement);
    await setDevEntitlementOverride(newEntitlement);
    await refreshEntitlement();
    Alert.alert('Updated', `Entitlement set to ${newEntitlement.toUpperCase()}`);
  };

  const handleCycleEntitlementDev = async () => {
    // Ensure dev mode is ON so getUserTier() will honor the override
    await setDevModeEnabled(true);
    setDevModeEnabledState(true);
    const order: Entitlement[] = ['free', 'pro', 'flow'];
    const currentIndex = order.indexOf(entitlement);
    const next = order[(currentIndex + 1) % order.length];
    await handleEntitlementChange(next);
  };

  const tierLabel = entitlement === 'flow' ? 'Flow' : entitlement === 'pro' ? 'Pro' : 'Free';
  const planSummary = PLAN_SUMMARIES[entitlement];

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.backgroundTop }]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 20) + 12 }]}
        showsVerticalScrollIndicator={false}>
        <ThemedText type="title" style={[styles.pageTitle, { color: theme.text }]}>
          Profile
        </ThemedText>

        {/* Your Plan card */}
        <Pressable
          onPress={handlePlanCardPress}
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border },
            pressed && { opacity: 0.95 },
          ]}>
          <View style={styles.cardHeaderRow}>
            <ThemedText style={[styles.cardTitle, { color: theme.text }]}>Your Plan</ThemedText>
            <TouchableOpacity
              onPress={handleRefreshSubscription}
              style={styles.refreshIconButton}
              disabled={isRefreshingSubscription}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {isRefreshingSubscription ? (
                <ActivityIndicator size="small" color={theme.accentWarm} />
              ) : (
                <ThemedText style={[styles.refreshIcon, { color: theme.mutedText }]}>⟳</ThemedText>
              )}
            </TouchableOpacity>
          </View>
          <ThemedText style={[styles.tierLabel, { color: isPro ? theme.accentWarm : theme.mutedText }]}>
            {tierLabel}
          </ThemedText>
          <ThemedText style={[styles.planSummary, { color: theme.mutedText }]}>{planSummary}</ThemedText>

          {entitlement === 'free' && (
            <>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: theme.accentWarm }]}
                onPress={() => router.push('/paywall')}
                activeOpacity={0.9}>
                <ThemedText style={[styles.primaryButtonText, { color: theme.background }]}>Upgrade</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={styles.textButton} onPress={handleRestorePurchases} disabled={isRestoring}>
                {isRestoring ? (
                  <ActivityIndicator size="small" color={theme.accentWarm} />
                ) : (
                  <ThemedText style={[styles.textButtonLabel, { color: theme.mutedText }]}>Restore purchases</ThemedText>
                )}
              </TouchableOpacity>
            </>
          )}

          {(entitlement === 'pro' || entitlement === 'flow') && (
            <>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: theme.accentWarm }]}
                onPress={openManageSubscription}
                activeOpacity={0.9}>
                <ThemedText style={[styles.primaryButtonText, { color: theme.background }]}>Manage subscription</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={styles.textButton} onPress={handleRestorePurchases} disabled={isRestoring}>
                {isRestoring ? (
                  <ActivityIndicator size="small" color={theme.accentWarm} />
                ) : (
                  <ThemedText style={[styles.textButtonLabel, { color: theme.mutedText }]}>Restore purchases</ThemedText>
                )}
              </TouchableOpacity>
            </>
          )}
        </Pressable>

        {/* APP */}
        <ThemedText style={[styles.sectionTitle, { color: theme.mutedText }]}>App</ThemedText>
        <View style={[styles.listCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.listRow, styles.listRowDisabled, { borderColor: theme.border }]}>
            <ThemedText style={[styles.listRowLabel, { color: theme.mutedText }]}>Notifications</ThemedText>
            <View style={[styles.badge, { backgroundColor: theme.surfaceSoft }]}>
              <ThemedText style={[styles.badgeText, { color: theme.mutedText }]}>Coming soon</ThemedText>
            </View>
          </View>
          <View style={[styles.listRowBorder, { borderColor: theme.border }]} />
          {isPro ? (
            <TouchableOpacity
              style={[styles.listRow, { borderColor: theme.border }]}
              onPress={() => router.push('/settings')}
              activeOpacity={0.7}>
              <ThemedText style={[styles.listRowLabel, { color: theme.text }]}>Playback preferences</ThemedText>
              <ThemedText style={[styles.chevron, { color: theme.mutedText }]}>›</ThemedText>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.listRow, { borderColor: theme.border }]}
              onPress={() => router.push('/paywall')}
              activeOpacity={0.7}>
              <ThemedText style={[styles.listRowLabel, { color: theme.mutedText }]}>Playback preferences</ThemedText>
              <View style={[styles.badge, { backgroundColor: theme.accentWarmMuted }]}>
                <ThemedText style={[styles.badgeText, { color: theme.accentWarm }]}>Pro+</ThemedText>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* LEGAL */}
        <ThemedText style={[styles.sectionTitle, { color: theme.mutedText }]}>Legal</ThemedText>
        <View style={[styles.listCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity style={[styles.listRow, { borderColor: theme.border }]} onPress={() => openURL(privacyPolicyUrl)} activeOpacity={0.7}>
            <ThemedText style={[styles.listRowLabel, { color: theme.accentWarm }]}>Privacy Policy</ThemedText>
            <ThemedText style={[styles.chevron, { color: theme.mutedText }]}>›</ThemedText>
          </TouchableOpacity>
          <View style={[styles.listRowBorder, { borderColor: theme.border }]} />
          <TouchableOpacity style={[styles.listRow, { borderColor: theme.border }]} onPress={() => openURL(termsOfServiceUrl)} activeOpacity={0.7}>
            <ThemedText style={[styles.listRowLabel, { color: theme.accentWarm }]}>Terms of Service</ThemedText>
            <ThemedText style={[styles.chevron, { color: theme.mutedText }]}>›</ThemedText>
          </TouchableOpacity>
        </View>

        {/* SUPPORT */}
        <ThemedText style={[styles.sectionTitle, { color: theme.mutedText }]}>Support</ThemedText>
        <View style={[styles.listCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity
            style={[styles.listRow, { borderColor: theme.border }]}
            onPress={() => openURL(`mailto:${SUPPORT_EMAIL}`)}
            activeOpacity={0.7}>
            <ThemedText style={[styles.listRowLabel, { color: theme.accentWarm }]}>Contact Support</ThemedText>
            <ThemedText style={[styles.chevron, { color: theme.mutedText }]}>›</ThemedText>
          </TouchableOpacity>
          <View style={[styles.listRowBorder, { borderColor: theme.border }]} />
          <View style={[styles.listRow, { borderColor: theme.border }]}>
            <ThemedText style={[styles.listRowLabel, { color: theme.mutedText }]}>App version</ThemedText>
            <ThemedText style={[styles.versionValue, { color: theme.text }]}>
              {appVersion} ({buildNumber})
            </ThemedText>
          </View>
          {__DEV__ && (
            <>
              <TouchableOpacity
                style={[styles.listRow, { borderColor: theme.border }]}
                onPress={() => setShowAdvanced((v) => !v)}
                activeOpacity={0.7}>
                <ThemedText style={[styles.listRowLabel, { color: theme.mutedText }]}>Advanced</ThemedText>
                <ThemedText style={[styles.chevron, { color: theme.mutedText }]}>
                  {showAdvanced ? '▼' : '›'}
                </ThemedText>
              </TouchableOpacity>
              {showAdvanced && (
                <View style={[styles.advancedBlock, { borderTopColor: theme.border }]}>
                  <View style={styles.versionRow}>
                    <ThemedText style={[styles.versionLabel, { color: theme.mutedText }]}>
                      RevenueCat App User ID
                    </ThemedText>
                    <ThemedText
                      style={[styles.versionValue, { color: theme.text }]}
                      numberOfLines={1}
                      ellipsizeMode="middle">
                      {supportInfo?.appUserId ?? '—'}
                    </ThemedText>
                  </View>
                  <View style={styles.versionRow}>
                    <ThemedText style={[styles.versionLabel, { color: theme.mutedText }]}>Entitlement</ThemedText>
                    <ThemedText style={[styles.versionValue, { color: theme.text }]}>
                      {entitlement.charAt(0).toUpperCase() + entitlement.slice(1)}
                    </ThemedText>
                  </View>
                  <TouchableOpacity
                    style={[styles.primaryButton, { backgroundColor: theme.surfaceSoft, marginTop: 8 }]}
                    onPress={handleCycleEntitlementDev}
                    activeOpacity={0.8}>
                    <ThemedText style={[styles.primaryButtonText, { color: theme.text }]}>
                      Cycle entitlement (dev)
                    </ThemedText>
                  </TouchableOpacity>
                  {devModeEnabled && (
                    <View style={styles.chipRow}>
                      {(['free', 'pro', 'flow'] as Entitlement[]).map((tier) => (
                        <TouchableOpacity
                          key={tier}
                          style={[
                            styles.chip,
                            { borderColor: theme.border },
                            selectedEntitlement === tier && {
                              backgroundColor: theme.accentWarm,
                              borderColor: theme.accentWarm,
                            },
                          ]}
                          onPress={() => handleEntitlementChange(tier)}>
                          <ThemedText
                            style={[
                              styles.chipText,
                              { color: theme.mutedText },
                              selectedEntitlement === tier && { color: theme.background },
                            ]}>
                            {tier.toUpperCase()}
                          </ThemedText>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </>
          )}
        </View>

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
  card: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    borderWidth: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', marginBottom: 6 },
  tierLabel: { fontSize: 24, fontWeight: '700', marginBottom: 6 },
  planSummary: { fontSize: 14, marginBottom: 20 },
  primaryButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '600' },
  textButton: { paddingVertical: 12, alignItems: 'center' },
  textButtonLabel: { fontSize: 14 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  listCard: { borderRadius: 16, borderWidth: 1, overflow: 'hidden', marginBottom: 20 },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 18 },
  listRowDisabled: { opacity: 0.8 },
  listRowBorder: { borderBottomWidth: 1, marginLeft: 18 },
  listRowLabel: { fontSize: 16, fontWeight: '500' },
  chevron: { fontSize: 18 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  versionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 18 },
  versionLabel: { fontSize: 13 },
  versionValue: { fontSize: 13 },
  advancedBlock: { borderTopWidth: 1, paddingTop: 12, paddingBottom: 12, paddingHorizontal: 18 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '600' },
  refreshIconButton: {
    paddingLeft: 8,
  },
  refreshIcon: {
    fontSize: 16,
  },
});
