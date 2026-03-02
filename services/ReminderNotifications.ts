import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEYS = {
  REMINDER_ENABLED: 'reminderEnabled',
  REMINDER_HOUR: 'reminderHour',
  REMINDER_MINUTE: 'reminderMinute',
  REMINDER_NOTIFICATION_ID: 'reminderNotificationId',
} as const;

const DAILY_CHANNEL_ID = 'pep-daily-reminder';

/** In Expo Go (SDK 53+), push/remote was removed; avoid loading expo-notifications to prevent the warning. */
function isExpoGo(): boolean {
  return Constants.appOwnership === 'expo';
}

export type ReminderSettings = {
  enabled: boolean;
  hour: number;
  minute: number;
  notificationId: string | null;
};

const DEFAULT_SETTINGS: ReminderSettings = {
  enabled: false,
  hour: 8,
  minute: 0,
  notificationId: null,
};

/** Lazy-load expo-notifications (avoids loading in Expo Go so push-token warning never runs). */
async function getNotifications() {
  if (isExpoGo()) return null;
  const Notifications = await import('expo-notifications');
  return Notifications;
}

/** Ensure Android channel exists for daily reminder */
async function ensureChannel(): Promise<void> {
  const Notifications = await getNotifications();
  if (!Notifications || Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(DAILY_CHANNEL_ID, {
    name: 'Daily reminder',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
  });
}

export async function loadReminderSettings(): Promise<ReminderSettings> {
  try {
    const [enabled, hour, minute, notificationId] = await AsyncStorage.multiGet([
      STORAGE_KEYS.REMINDER_ENABLED,
      STORAGE_KEYS.REMINDER_HOUR,
      STORAGE_KEYS.REMINDER_MINUTE,
      STORAGE_KEYS.REMINDER_NOTIFICATION_ID,
    ]);
    return {
      enabled: enabled[1] === 'true',
      hour: Math.min(23, Math.max(0, parseInt(hour[1] ?? '8', 10) || 8)),
      minute: Math.min(59, Math.max(0, parseInt(minute[1] ?? '0', 10) || 0)),
      notificationId: notificationId[1] || null,
    };
  } catch (e) {
    console.warn('[Reminder] loadReminderSettings failed:', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  await AsyncStorage.multiSet([
    [STORAGE_KEYS.REMINDER_ENABLED, settings.enabled ? 'true' : 'false'],
    [STORAGE_KEYS.REMINDER_HOUR, String(settings.hour)],
    [STORAGE_KEYS.REMINDER_MINUTE, String(settings.minute)],
    [STORAGE_KEYS.REMINDER_NOTIFICATION_ID, settings.notificationId ?? ''],
  ]);
}

/**
 * Schedule a daily local notification at the given time.
 * Returns the notification identifier. In Expo Go, returns a placeholder (reminders require a dev build).
 */
export async function scheduleDailyReminder(hour: number, minute: number): Promise<string> {
  const Notifications = await getNotifications();
  if (!Notifications) return 'expo-go-unsupported';
  await ensureChannel();
  const trigger: import('expo-notifications').NotificationTriggerInput = {
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
    repeats: true,
    ...(Platform.OS === 'android' ? { channelId: DAILY_CHANNEL_ID } : {}),
  };
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Pep',
      body: 'Your daily pep is ready.',
    },
    trigger,
  });
  return id;
}

/**
 * Cancel a previously scheduled daily reminder by id.
 */
export async function cancelDailyReminder(notificationId: string | null): Promise<void> {
  if (!notificationId || notificationId === 'expo-go-unsupported') return;
  const Notifications = await getNotifications();
  if (!Notifications) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch (e) {
    console.warn('[Reminder] cancelDailyReminder failed:', e);
  }
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * Request notification permission. Returns status. In Expo Go, returns 'undetermined' (reminders need a dev build).
 */
export async function requestNotificationPermission(): Promise<PermissionStatus> {
  const Notifications = await getNotifications();
  if (!Notifications) return 'undetermined';
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return existing;
  const { status } = await Notifications.requestPermissionsAsync();
  return status;
}

export async function getNotificationPermissionStatus(): Promise<PermissionStatus> {
  const Notifications = await getNotifications();
  if (!Notifications) return 'undetermined';
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

/** True when reminders are supported (dev build or standalone); false in Expo Go. */
export function isReminderSupported(): boolean {
  return !isExpoGo();
}

/** Preset times for the time picker: 8am, 12pm, 6pm */
export const REMINDER_PRESETS: { label: string; hour: number; minute: number }[] = [
  { label: '8:00 AM', hour: 8, minute: 0 },
  { label: '12:00 PM', hour: 12, minute: 0 },
  { label: '6:00 PM', hour: 18, minute: 0 },
];
