import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { UserProvider } from '@/contexts/UserContext';
import { AudioPlaybackProvider } from '@/contexts/AudioPlaybackContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Suppress non-critical keep-awake errors from expo-av
  // This error is harmless - audio playback still works
  if (typeof ErrorUtils !== 'undefined') {
    const originalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      // Suppress keep-awake errors (non-critical, audio still works)
      if (error?.message?.includes('keep awake') || error?.message?.includes('Unable to activate keep awake')) {
        console.log('[APP] Suppressed keep-awake error (non-critical):', error.message);
        return;
      }
      // Call original handler for other errors
      if (originalHandler) {
        originalHandler(error, isFatal);
      }
    });
  }

  // Also handle unhandled promise rejections
  if (typeof global !== 'undefined' && global.Promise) {
    const originalUnhandledRejection = global.Promise?.reject;
    // Suppress keep-awake promise rejections
    const originalRejectionHandler = (global as any).__unhandledRejectionHandler;
    (global as any).__unhandledRejectionHandler = (reason: any) => {
      if (reason?.message?.includes('keep awake') || reason?.message?.includes('Unable to activate keep awake')) {
        console.log('[APP] Suppressed keep-awake promise rejection (non-critical):', reason?.message);
        return;
      }
      if (originalRejectionHandler) {
        originalRejectionHandler(reason);
      }
    };
  }

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AudioPlaybackProvider>
          <UserProvider>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <SafeAreaView style={{ flex: 1 }} edges={['top']}>
                <Stack>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="settings" options={{ title: 'Playback Preferences', presentation: 'modal' }} />
                  <Stack.Screen name="library" options={{ title: 'Library', presentation: 'modal' }} />
                  <Stack.Screen name="paywall" options={{ title: 'Upgrade to Pro', presentation: 'modal' }} />
                  <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
                </Stack>
                <StatusBar style="auto" />
              </SafeAreaView>
            </ThemeProvider>
          </UserProvider>
        </AudioPlaybackProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
