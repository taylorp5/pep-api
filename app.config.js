const path = require('path');
const fs = require('fs');

// Load apps/mobile/.env so API URL and RevenueCat keys are in extra at build time.
// EAS builds: set EXPO_PUBLIC_API_URL and EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY in expo.dev
// (Project → Environment variables). Attach to the same environment as your build profile (e.g. Production).
let apiUrlFromEnv = null;
let revenueCatAndroid = null;
let revenueCatIos = null;
let revenueCatApiKey = null;
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  let content = fs.readFileSync(envPath, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
        if (key === 'EXPO_PUBLIC_API_URL') apiUrlFromEnv = value.replace(/\/$/, '');
        if (key === 'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY') revenueCatAndroid = value;
        if (key === 'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY') revenueCatIos = value;
        if (key === 'EXPO_PUBLIC_REVENUECAT_API_KEY') revenueCatApiKey = value;
      }
    }
  });
}

// EAS env overrides (process.env set by EAS when building). Trim to avoid spaces breaking the key.
// Prefer EXPO_PUBLIC_* (inlined by Metro); fallback to non-prefixed in case EAS sets only those.
const trim = (v) => (typeof v === 'string' ? v.trim() : v);
const apiUrl = trim(process.env.EXPO_PUBLIC_API_URL) || apiUrlFromEnv;
const androidKey =
  trim(process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY) ||
  revenueCatAndroid ||
  revenueCatApiKey;
const iosKey =
  trim(process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY) ||
  revenueCatIos ||
  revenueCatApiKey;

const appJson = require('./app.json');
module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    plugins: [...(appJson.expo.plugins || []), 'expo-dev-client'],
    extra: {
      ...(appJson.expo.extra || {}),
      apiUrl: apiUrl || undefined,
      revenueCatAndroidApiKey: androidKey || undefined,
      revenueCatIosApiKey: iosKey || undefined,
      revenueCatApiKey: revenueCatApiKey || undefined,
      privacyPolicyUrl: trim(process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL) || appJson.expo.extra?.privacyPolicyUrl,
      termsOfServiceUrl: trim(process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL) || appJson.expo.extra?.termsOfServiceUrl,
      eas: {
        projectId: '340002ef-6f70-4773-a8b8-6efd52e7ca74',
      },
    },
  },
};
