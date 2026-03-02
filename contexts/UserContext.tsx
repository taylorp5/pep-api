import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CustomerInfo } from 'react-native-purchases';
import { getUserTier, getPurchases, initRevenueCat, type Entitlement, type Tier } from '@/services/subscription';

type UserContextType = {
  isPro: boolean;
  entitlement: Entitlement;
  /** Single source of truth: current tier (free | pro | flow). Same as entitlement. */
  getUserTier: () => Promise<Tier>;
  refreshEntitlement: () => Promise<void>;
  customPepCount: number;
  useCustomPep: () => Promise<boolean>;
  getRemainingCustomPeps: () => number;
  /** True for Flow: no visible daily limit (fair-use cap is hidden unless exceeded). */
  hasUnlimitedCustomPeps: boolean;
  refreshDailyCounts: () => Promise<void>;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

const STORAGE_KEYS = {
  LAST_USED_DATE: 'lastUsedDate',
  CUSTOM_PEP_COUNT: 'customPepCount',
};

const FREE_LIMITS = {
  MAX_CUSTOM_PEPS: 1,
  MAX_DURATION_SECONDS: 30,
};

const PRO_LIMITS = {
  MAX_CUSTOM_PEPS: 5,
  MAX_DURATION_SECONDS: 90,
};

/** Flow: unlimited in UI. Hidden fair-use cap only (not shown unless exceeded). */
const FLOW_FAIR_USE_CAP = 100;
const FLOW_LIMITS = {
  MAX_CUSTOM_PEPS: FLOW_FAIR_USE_CAP,
  MAX_DURATION_SECONDS: 180, // 3 minutes (deep sessions + Continue)
};

export function UserProvider({ children }: { children: ReactNode }) {
  const [entitlement, setEntitlement] = useState<Entitlement>('free');
  const [customPepCount, setCustomPepCount] = useState(0);
  const [lastUsedDate, setLastUsedDate] = useState<string | null>(null);
  const [entitlementLoading, setEntitlementLoading] = useState(true);
  
  // isPro for backward compatibility (true if pro or flow)
  const isPro = entitlement === 'pro' || entitlement === 'flow';

  // Get today's date as YYYY-MM-DD
  const getTodayDate = (): string => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  };

  // Check if we need to reset daily counts
  const checkAndResetDailyCounts = async () => {
    const today = getTodayDate();
    const storedDate = await AsyncStorage.getItem(STORAGE_KEYS.LAST_USED_DATE);

    if (storedDate !== today) {
      // Date changed, reset counts
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.LAST_USED_DATE, today],
        [STORAGE_KEYS.CUSTOM_PEP_COUNT, '0'],
      ]);
      setCustomPepCount(0);
      setLastUsedDate(today);
    } else {
      setLastUsedDate(today);
    }
  };

  // Load entitlement from subscription service (single source of truth: getUserTier)
  const refreshEntitlement = async () => {
    try {
      const tier = await getUserTier();
      setEntitlement(tier);
    } catch (error) {
      console.error('Error fetching entitlement:', error);
      setEntitlement('free');
    } finally {
      setEntitlementLoading(false);
    }
  };

  // Init RevenueCat after app/native is ready, then load state and subscribe to entitlement changes
  useEffect(() => {
    const loadStateAndSubscribe = async () => {
      let subscriptionListener: ((info: CustomerInfo) => void) | null = null;

      try {
        await new Promise<void>((r) => {
          const { InteractionManager } = require('react-native');
          InteractionManager.runAfterInteractions(() => setTimeout(r, 150));
        });
        await initRevenueCat();
        await refreshEntitlement();

        // Keep entitlement in sync with RevenueCat in near real-time.
        // This ensures Home/Profile unlock Pro/Flow immediately after purchase, restore, or external changes.
        subscriptionListener = (info: CustomerInfo) => {
          try {
            const active = info.entitlements.active;
            if (active['flow']) {
              setEntitlement('flow');
            } else if (active['pro']) {
              setEntitlement('pro');
            } else {
              setEntitlement('free');
            }
          } catch (error) {
            console.error('[RevenueCat] customerInfo listener failed:', error);
          }
        };
        const Purchases = getPurchases();
        if (Purchases) Purchases.addCustomerInfoUpdateListener(subscriptionListener);

        // Load daily usage counts
        const [storedDate, customPepValue] = await AsyncStorage.multiGet([
          STORAGE_KEYS.LAST_USED_DATE,
          STORAGE_KEYS.CUSTOM_PEP_COUNT,
        ]);

        setLastUsedDate(storedDate[1] || null);

        const today = getTodayDate();
        if (storedDate[1] === today) {
          // Same day, load counts
          setCustomPepCount(parseInt(customPepValue[1] || '0', 10));
        } else {
          // Different day or first time, reset
          await checkAndResetDailyCounts();
        }
      } catch (error) {
        console.error('Error loading user state:', error);
        await checkAndResetDailyCounts();
        // Ensure entitlement is loaded even if other state fails
        try {
          await refreshEntitlement();
        } catch (entitlementError) {
          console.error('Error loading entitlement in fallback:', entitlementError);
        }
      }

      return () => {
        if (subscriptionListener) {
          const Purchases = getPurchases();
          if (Purchases) {
            try {
              // @ts-expect-error - type may differ between SDK versions; this is safe at runtime where supported.
              Purchases.removeCustomerInfoUpdateListener(subscriptionListener);
            } catch {
              // ignore
            }
          }
        }
      };
    };

    const subscriptionCleanupPromise = loadStateAndSubscribe();

    return () => {
      // Ensure listener is removed if effect is cleaned up before init resolves.
      subscriptionCleanupPromise
        .then((cleanup) => {
          if (typeof cleanup === 'function') cleanup();
        })
        .catch(() => {});
    };
  }, []);

  // Refresh daily counts (called when date might have changed)
  const refreshDailyCounts = async () => {
    await checkAndResetDailyCounts();
  };

  const useCustomPep = async (): Promise<boolean> => {
    await checkAndResetDailyCounts();

    let maxPeps: number;
    if (entitlement === 'flow') {
      maxPeps = FLOW_LIMITS.MAX_CUSTOM_PEPS;
    } else if (entitlement === 'pro') {
      maxPeps = PRO_LIMITS.MAX_CUSTOM_PEPS;
    } else {
      maxPeps = FREE_LIMITS.MAX_CUSTOM_PEPS;
    }

    if (customPepCount >= maxPeps) {
      return false; // Limit reached
    }

    setCustomPepCount(customPepCount + 1);
    await AsyncStorage.setItem(STORAGE_KEYS.CUSTOM_PEP_COUNT, String(customPepCount + 1));
    return true;
  };

  const getRemainingCustomPeps = (): number => {
    if (entitlement === 'flow') return 999; // No visible limit; UI shows "Unlimited" or nothing
    if (entitlement === 'pro') return Math.max(0, PRO_LIMITS.MAX_CUSTOM_PEPS - customPepCount);
    return Math.max(0, FREE_LIMITS.MAX_CUSTOM_PEPS - customPepCount);
  };

  const hasUnlimitedCustomPeps = entitlement === 'flow';

  const getMaxDuration = (): number => {
    if (entitlement === 'flow') {
      return FLOW_LIMITS.MAX_DURATION_SECONDS;
    } else if (entitlement === 'pro') {
      return PRO_LIMITS.MAX_DURATION_SECONDS;
    } else {
      return FREE_LIMITS.MAX_DURATION_SECONDS;
    }
  };

  return (
    <UserContext.Provider
      value={{
        isPro,
        entitlement,
        getUserTier,
        refreshEntitlement,
        customPepCount,
        useCustomPep,
        getRemainingCustomPeps,
        hasUnlimitedCustomPeps,
        refreshDailyCounts,
      }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
