# EAS Build – Why your changes might not appear

If you run `npx eas build --platform android --profile production --clear-cache` from `C:\dev\Pep\apps\mobile` but the installed app doesn’t show recent changes, check the following.

## 1. You’re installing the new build

- In [expo.dev](https://expo.dev) → your project → **Builds**, open the **latest** Android production build.
- Download the **APK** from that build (not an older build).
- Install that APK on the device (replace the existing app if needed).
- If you use **Play Console internal testing**, upload this **new** APK and install the new internal test version. Old internal test builds won’t have your latest code.

## 2. Confirm which app version is installed

- In the installed app, open **Settings** (or Profile → Settings).
- Check **App version** (e.g. `1.1.5 (15)`). Compare with the version in `app.json` and the build you just made.
- If the version is older than your current `app.json`, you’re still running an old build.

## 3. See exactly what EAS uploads

From `apps\mobile`:

```bash
npx eas build:inspect --platform android --profile production --output ./build-inspect
```

Then open `build-inspect` and confirm your changed files (e.g. `app/settings.tsx`, `app/(tabs)/_layout.tsx`, `screens/HomeScreen.tsx`) are in the archive. If they’re missing, something is excluding them.

## 4. Commit before building (recommended)

So the build matches a known state:

1. Commit all changes in `apps\mobile` (and the rest of the repo if needed).
2. From `apps\mobile` run:
   ```bash
   npx eas build --platform android --profile production --clear-cache
   ```
3. Use the APK from that build for internal testing.

## 5. Run from the correct directory

Always run EAS from the app directory:

```bash
cd C:\dev\Pep\apps\mobile
npx eas build --platform android --profile production --clear-cache
```

Do **not** run `eas build` from `C:\dev\Pep` or `C:\dev\Pep\mobile`; that can build a different app (e.g. the `mobile` folder has its own `app.json` with slug `"mobile"` and no Pep code).

## Quick checklist

- [ ] Run `eas build` from `C:\dev\Pep\apps\mobile`
- [ ] Commit your changes before building
- [ ] Download the APK from the **latest** build in the EAS dashboard
- [ ] Upload that **same** APK to Play Console as the new internal test version
- [ ] Install the new internal test build on the device
- [ ] In the app, open Settings and confirm the version matches your latest `app.json`
