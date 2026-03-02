/**
 * Subscription Service — RevenueCat
 *
 * Single source of truth: getUserTier() => 'free' | 'pro' | 'flow'
 * - In __DEV__ with dev mode enabled, dev override (if set) wins.
 * - Otherwise tier comes from RevenueCat entitlements "pro" and "flow".
 *
 * Expo Go: RevenueCat native module is not available. We lazy-load it only when
 * not running in Expo Go (appOwnership !== 'expo') so the app runs in Expo Go
 * and you can use the dev entitlement override to test Pro/Flow without purchasing.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type {
  PurchasesOffering,
  PurchasesPackage,
  CustomerInfo,
} from 'react-native-purchases';

/** Lazy-load RevenueCat so Expo Go never requires the native module (avoids crash). */
function getPurchasesModule(): typeof import('react-native-purchases') | null {
  if (Constants.appOwnership === 'expo') return null;
  try {
    return require('react-native-purchases');
  } catch {
    return null;
  }
}

const DEV_OVERRIDE_KEY = 'devEntitlementOverride';

export type Entitlement = 'free' | 'pro' | 'flow';

export type Tier = Entitlement;

let revenueCatConfigured = false;
/** Ensures Purchases.configure() is called at most once per app lifecycle. */
let configureCalled = false;
/** Last init result for in-app display (no adb needed). */
let lastRevenueCatStatus: string = 'Not run';

const trim = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.trim() || undefined : undefined;

/** Safe key prefix for logging (e.g. "goog_…"). */
function keyPrefix(key: string, len: number = 6): string {
  return key.length >= len ? key.slice(0, len) + '…' : '…';
}

/** Resolve API key. Android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY then extra. */
function getRevenueCatApiKey(): { apiKey: string; source: string } | null {
  const extra =
    (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ??
    (Constants.manifest?.extra as Record<string, unknown> | undefined);

  const fromExtraAndroid = trim(extra?.revenueCatAndroidApiKey);
  const fromExtraIos = trim(extra?.revenueCatIosApiKey);
  const fromExtraSingle = trim(extra?.revenueCatApiKey);
  const fromEnvAndroid = typeof process !== 'undefined' ? trim(process.env?.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY) : undefined;
  const fromEnvIos = typeof process !== 'undefined' ? trim(process.env?.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY) : undefined;

  if (Platform.OS === 'android') {
    const key = fromEnvAndroid ?? fromExtraAndroid ?? fromExtraSingle;
    if (key) {
      const source = fromEnvAndroid ? 'process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY' : fromExtraAndroid ? 'extra' : 'extra (single)';
      return { apiKey: key, source };
    }
  } else {
    const key = fromEnvIos ?? fromExtraIos ?? fromExtraSingle;
    if (key) {
      const source = fromEnvIos ? 'process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY' : fromExtraIos ? 'extra' : 'extra (single)';
      return { apiKey: key, source };
    }
  }
  return null;
}

/** True if SDK key is present (for debug UI). Does not imply configure succeeded. */
export function isRevenueCatKeyPresent(): boolean {
  return getRevenueCatApiKey() !== null;
}

/** Log diagnostic when key is missing (safe: no key values). */
function logKeyMissing(): void {
  if (__DEV__) {
    const hasExtra = !!(
      (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.revenueCatAndroidApiKey ??
      (Constants.manifest?.extra as Record<string, unknown> | undefined)?.revenueCatAndroidApiKey
    );
    console.warn('[RevenueCat] key present: false. extra has key?', hasExtra);
  }
}

/**
 * Configure RevenueCat. Called exactly once at app startup (guard: configureCalled).
 */
export async function initRevenueCat(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return;
  }
  if (revenueCatConfigured) return;

  const resolved = getRevenueCatApiKey();
  if (!resolved) {
    logKeyMissing();
    lastRevenueCatStatus = 'SDK key missing';
    return;
  }
  const { apiKey, source } = resolved;
  if (__DEV__) {
    console.log('[RevenueCat] key present: true, key prefix (first 6 chars):', keyPrefix(apiKey, 6));
  }

  if (configureCalled) {
    return;
  }
  configureCalled = true;

  const RNP = getPurchasesModule();
  if (!RNP) {
    lastRevenueCatStatus = 'Expo Go (subscriptions unavailable)';
    if (__DEV__) console.log('[RevenueCat] Skipping init in Expo Go; use dev entitlement override to test Pro/Flow.');
    return;
  }

  try {
    await RNP.default.configure({ apiKey });
    if (__DEV__) {
      RNP.default.setLogLevel(RNP.LOG_LEVEL.DEBUG);
    }
    revenueCatConfigured = true;
    lastRevenueCatStatus = `OK (${source})`;
    console.log('[RevenueCat] init: configured OK, source:', source);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    lastRevenueCatStatus = `Initialization failed: ${errMsg}`;
    console.error('[RevenueCat] Configure failed:', errMsg);
  }
}

/** For use by UserContext (listeners). Null in Expo Go. */
export function getPurchases(): typeof import('react-native-purchases').default | null {
  return getPurchasesModule()?.default ?? null;
}

/** Whether RevenueCat was successfully configured (rcReady). Block purchase/restore until true. */
export function isRevenueCatConfigured(): boolean {
  return revenueCatConfigured;
}

/** Resolves when RevenueCat is configured (rcReady) or after timeout. Use to block purchase/restore UI until ready. */
export function waitForRevenueCatReady(timeoutMs: number = 5000): Promise<boolean> {
  if (revenueCatConfigured) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (revenueCatConfigured) {
        clearInterval(t);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, 100);
  });
}

/** Status for UI: configured, and a clear error message if not (key missing vs init failed). */
export function getRevenueCatStatus(): { configured: boolean; message: string } {
  const message =
    revenueCatConfigured
      ? lastRevenueCatStatus
      : lastRevenueCatStatus === 'SDK key missing'
        ? 'Subscriptions are not set up for this build. Please update the app or contact support.'
        : lastRevenueCatStatus === 'Not run'
          ? 'Initializing…'
          : lastRevenueCatStatus;
  return { configured: revenueCatConfigured, message };
}

/** Debug info for debug screen: platform, sdk key present, current offering id, package identifiers. */
export async function getRevenueCatDebugInfo(): Promise<{
  platform: string;
  sdkKeyPresent: boolean;
  currentOfferingIdentifier: string | null;
  packageIdentifiers: string[];
}> {
  const platform = Platform.OS;
  const sdkKeyPresent = getRevenueCatApiKey() !== null;
  let currentOfferingIdentifier: string | null = null;
  let packageIdentifiers: string[] = [];
  if (revenueCatConfigured) {
    const RNP = getPurchasesModule();
    if (RNP) {
      try {
        const offerings = await RNP.default.getOfferings();
      const current = offerings.current;
      currentOfferingIdentifier = current?.identifier ?? null;
      packageIdentifiers = (current?.availablePackages ?? []).map((p) => p.identifier ?? '');
      } catch {
        // ignore
      }
    }
  }
  return {
    platform,
    sdkKeyPresent,
    currentOfferingIdentifier,
    packageIdentifiers,
  };
}

/**
 * Single source of truth for app tier.
 * - __DEV__ + dev mode enabled + override set → return override.
 * - Otherwise return RevenueCat entitlement (pro / flow) or 'free'.
 */
export async function getUserTier(): Promise<Tier> {
  if (__DEV__) {
    const devMode = await getDevModeEnabled();
    if (devMode) {
      const override = await AsyncStorage.getItem(DEV_OVERRIDE_KEY);
      if (override === 'free' || override === 'pro' || override === 'flow') {
        return override as Tier;
      }
    }
  }

  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return 'free';
  }
  if (!revenueCatConfigured) {
    return 'free';
  }
  const RNP = getPurchasesModule();
  if (!RNP) return 'free';

  try {
    const customerInfo = await RNP.default.getCustomerInfo();
    return tierFromCustomerInfo(customerInfo);
  } catch (e) {
    console.error('[RevenueCat] getCustomerInfo failed:', e);
    return 'free';
  }
}

function tierFromCustomerInfo(info: CustomerInfo): Tier {
  const active = info.entitlements.active;
  if (active['flow']) return 'flow';
  if (active['pro']) return 'pro';
  return 'free';
}

/** Support info: RevenueCat app user ID and current entitlement (for Profile/Settings). */
export async function getSupportInfo(): Promise<{
  appUserId: string;
  entitlement: Entitlement;
} | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android' || !revenueCatConfigured) {
    return null;
  }
  const RNP = getPurchasesModule();
  if (!RNP) return null;
  try {
    const customerInfo = await RNP.default.getCustomerInfo();
    const appUserId = (customerInfo as CustomerInfo & { originalAppUserId?: string }).originalAppUserId ?? '—';
    return {
      appUserId,
      entitlement: tierFromCustomerInfo(customerInfo),
    };
  } catch (e) {
    if (__DEV__) console.warn('[RevenueCat] getSupportInfo failed:', e);
    return null;
  }
}

/**
 * @deprecated Use getUserTier() for single source of truth.
 * Kept for backward compatibility with UserContext (refreshEntitlement).
 */
export const getEntitlement = getUserTier;

/**
 * Set dev-only entitlement override. Only applies when __DEV__ and dev mode is enabled (hidden in Profile).
 */
export async function setDevEntitlementOverride(entitlement: Entitlement): Promise<void> {
  await AsyncStorage.setItem(DEV_OVERRIDE_KEY, entitlement);
  if (__DEV__) {
    console.log(`[DEV] Entitlement override set to: ${entitlement}`);
  }
}

export async function getDevModeEnabled(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem('devModeEnabled');
    return value === 'true';
  } catch {
    return false;
  }
}

export async function setDevModeEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem('devModeEnabled', enabled ? 'true' : 'false');
  if (__DEV__) {
    console.log(`[DEV] Dev mode ${enabled ? 'enabled' : 'disabled'}`);
  }
}

/**
 * Restore purchases (RevenueCat).
 */
export async function restorePurchases(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return;
  }
  if (!revenueCatConfigured) {
    throw new Error('RevenueCat not configured');
  }
  const RNP = getPurchasesModule();
  if (!RNP) throw new Error('Subscriptions not available (e.g. Expo Go). Use a development build to test purchases.');
  await RNP.default.restorePurchases();
}

/**
 * Get current offerings for Pro/Flow packages.
 * Package identifiers: expect "pro" or "flow" in identifier, or use $default and pick by product.
 */
export async function getOfferings(): Promise<PurchasesOffering | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android' || !revenueCatConfigured) {
    return null;
  }
  const RNP = getPurchasesModule();
  if (!RNP) return null;
  try {
    const offerings = await RNP.default.getOfferings();
    return offerings.current;
  } catch (e) {
    console.error('[RevenueCat] getOfferings failed:', e);
    return null;
  }
}

function packageMatchesPro(p: PurchasesPackage): boolean {
  const id = p.identifier?.toLowerCase() ?? '';
  const productId = (p as PurchasesPackage & { product?: { identifier?: string } }).product?.identifier?.toLowerCase() ?? '';
  return id.includes('pro') || productId.includes('pro');
}

function packageMatchesFlow(p: PurchasesPackage): boolean {
  const id = p.identifier?.toLowerCase() ?? '';
  const productId = (p as PurchasesPackage & { product?: { identifier?: string } }).product?.identifier?.toLowerCase() ?? '';
  return id.includes('flow') || productId.includes('flow');
}

/** Find package that grants Pro (package or product identifier contains "pro"). */
export function getProPackage(offering: PurchasesOffering | null): PurchasesPackage | null {
  if (!offering?.availablePackages?.length) return null;
  return offering.availablePackages.find(packageMatchesPro) ?? null;
}

/** Find package that grants Flow (package or product identifier contains "flow"). */
export function getFlowPackage(offering: PurchasesOffering | null): PurchasesPackage | null {
  if (!offering?.availablePackages?.length) return null;
  return offering.availablePackages.find(packageMatchesFlow) ?? null;
}

/**
 * Purchase a package (RevenueCat). Use getProPackage / getFlowPackage to get the package.
 */
export async function purchasePackage(pkg: PurchasesPackage): Promise<CustomerInfo> {
  if (!revenueCatConfigured) {
    throw new Error('RevenueCat not configured');
  }
  const RNP = getPurchasesModule();
  if (!RNP) throw new Error('Subscriptions not available (e.g. Expo Go). Use a development build to test purchases.');
  const { customerInfo } = await RNP.default.purchasePackage(pkg);
  return customerInfo;
}

/**
 * Purchase Pro (convenience: gets offerings, finds Pro package, purchases).
 */
export async function purchasePro(): Promise<void> {
  const offering = await getOfferings();
  if (!offering?.availablePackages?.length) {
    throw new Error('Pro isn\'t available right now. Check your connection and try again, or use Restore purchases.');
  }
  const pkg = getProPackage(offering);
  if (!pkg) {
    throw new Error('Pro plan not found in this offering. Try Restore purchases if you already subscribed.');
  }
  await purchasePackage(pkg);
}

/**
 * Purchase Flow (convenience: gets offerings, finds Flow package, purchases).
 */
export async function purchaseFlow(): Promise<void> {
  const offering = await getOfferings();
  if (!offering?.availablePackages?.length) {
    throw new Error('Flow isn\'t available right now. Check your connection and try again, or use Restore purchases.');
  }
  const pkg = getFlowPackage(offering);
  if (!pkg) {
    throw new Error('Flow plan not found in this offering. Try Restore purchases if you already subscribed.');
  }
  await purchasePackage(pkg);
}

/** Legacy: was used by stub. No-op for RevenueCat (entitlement comes from getCustomerInfo). */
export async function setEntitlement(_entitlement: Entitlement): Promise<void> {
  // No-op; RevenueCat owns entitlement
}
