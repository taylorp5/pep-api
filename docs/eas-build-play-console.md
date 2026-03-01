# EAS Build → Play Console (Internal Release)

The **Pep app** and all recent changes (bottom nav, subscription copy, Settings, tiers, playlist, etc.) live in **`apps/mobile`** only. There is also a **`mobile`** folder at the repo root — that is a different/template app. **Always build from `apps/mobile`.**

## 1. Build the right app

From the repo root:

```bash
cd apps\mobile
```

Confirm you're in the Pep project:

- `app.json` should show `"name": "Pep"` and `"slug": "pep"`.
- If you see `"name": "mobile"` and `"slug": "mobile"`, you're in the wrong folder (that's the template app).

## 2. Commit your changes

EAS Build uses your **local project** when you run `eas build` from the CLI, but committing ensures:

- The build is reproducible.
- If you ever trigger a build from the EAS dashboard or from Git, the latest code is used.

```bash
cd c:\dev\Pep
git status
git add apps/mobile
git commit -m "Your changes message"
```

Then run the build from `apps/mobile` (step 3).

## 3. Run EAS Build from apps/mobile

```bash
cd c:\dev\Pep\apps\mobile
eas build --platform android --profile production
```

Or for an internal APK (preview):

```bash
eas build --platform android --profile preview
```

To avoid stale native/cache issues:

```bash
eas build --platform android --profile production --clear-cache
```

Wait for the build to finish in the EAS dashboard.

## 4. Use the new build in Play Console

- In [expo.dev](https://expo.dev) → your project → **Builds**, open the **latest** build (the one you just ran).
- Download the **Android App Bundle (.aab)** or APK.
- In **Google Play Console** → your app → **Testing** → **Internal testing** (or your chosen track):
  - Create a **new release**.
  - Upload this **new** build (not an older one).
  - **Version code** in `apps/mobile/app.json` must be **higher** than the version already in that track. If the store still shows an old build, bump `versionCode` in `app.json` (e.g. 15 → 16), then rebuild and upload again.

## 5. If you still don’t see changes

- Confirm the device is installing the **new** build (e.g. uninstall the old app, then install the new one from the internal testing link).
- Confirm you built from **`apps/mobile`** (Pep), not from **`mobile`** (template).
- Try: `eas build --platform android --profile production --clear-cache` and upload that build to Play Console.

## Quick check

Before building:

```bash
cd c:\dev\Pep\apps\mobile
# Should show "Pep" and "pep"
type app.json | findstr "name slug"
```

You should see `"name": "Pep"` and `"slug": "pep"`. If you see `"mobile"`, you're in the wrong directory.
