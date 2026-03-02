# App icon (Pep)

The app icon is set in **`app.json`**:

- **Default / iOS:** `./assets/images/pep-app-icon-android.png`
- **Android:** same file as `adaptiveIcon.foregroundImage` (with optional background/monochrome)

## If you still see the default Android icon

1. **Expo Go** always shows the Expo Go icon, not your app icon. To see the Pep icon you must use:
   - a **development build** (`eas build --profile development`), or  
   - a **preview/production build** (`eas build`).

2. **Regenerate native projects** so the icon is baked in:
   ```bash
   cd apps/mobile
   npx expo prebuild --clean
   ```
   Then run or build again (e.g. `npx expo run:android` or a new EAS build).

3. **EAS Build:** If you use EAS Build and your `android/` and `ios/` folders are in `.gitignore`, the cloud runs prebuild and should pick up the icon. If the icon still doesn’t change, try a new build (no cache):
   ```bash
   eas build --platform android --clear-cache
   ```

4. **Icon asset:** Use a **1024×1024 px** PNG for best results. The file must exist at `apps/mobile/assets/images/pep-app-icon-android.png`.
