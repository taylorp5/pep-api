# Moving to an EAS dev build

A **development build** is a custom app you install on your device (or emulator) that includes your app + dev tools. You stop using Expo Go and install this build instead. It’s the same flow as before: start the API and Metro, then open the dev build and point it at your dev server.

---

## 1. Prerequisites

- **Expo account** (free): [expo.dev](https://expo.dev) → sign up if needed.
- **EAS CLI** (one-time install):
  ```bash
  npm install -g eas-cli
  ```
- **In the mobile app folder** for all commands below:
  ```bash
  cd C:\dev\Pep\apps\mobile
  ```

---

## 2. Install expo-dev-client

Development builds need the dev client package:

```bash
cd C:\dev\Pep\apps\mobile
npx expo install expo-dev-client
```

The project is already configured to use it (plugin in `app.config.js`, `eas.json` in place).

---

## 3. Log in to EAS

```bash
eas login
```

Use your Expo account email and password (or create an account when prompted).

---

## 4. Configure the project (first time only)

If EAS has never been set up for this app, run:

```bash
eas build:configure
```

- It will detect the existing `eas.json` and may ask a few questions.
- You can accept defaults; the **development** profile is already set for a dev build with an **APK** on Android.

---

## 5. Build a development APK (Android)

From `apps/mobile`:

```bash
eas build --profile development --platform android
```

- EAS will run the build in the cloud.
- When prompted:
  - **Generate a new Android Keystore?** → Yes (unless you already have one).
- Build usually takes 10–20 minutes.
- When it’s done, you get a **link to download the APK**.

---

## 6. Install the APK on your phone

1. Open the build link on your **Android phone** (same browser or scan QR code from the EAS page).
2. Download the APK and install it (you may need to allow “Install from unknown sources” for the browser or Files app).
3. The app will appear as **“Pep”** (or “Pep (dev)”). That’s your dev build.

---

## 7. Run your app in the dev build

1. **Start the API** on your PC (same as before):
   ```bash
   cd C:\dev\Pep\api
   npm run dev
   ```

2. **Start the dev server** from the mobile app folder:
   ```bash
   cd C:\dev\Pep\apps\mobile
   npx expo start
   ```

3. **On your phone**: open the **Pep** dev build (not Expo Go).
   - It will try to connect to the dev server. If you’re on the same Wi‑Fi, it should find it automatically.
   - If it doesn’t, you may need to shake the device (or press the dev menu) and enter the URL manually (e.g. `http://10.0.0.9:8081` — your PC IP and Metro port).

4. **API URL**: as with Expo Go, use the in‑app **Set** to enter your PC’s API URL (e.g. `http://10.0.0.9:3001`) so the app can talk to your backend.

---

## 8. When to rebuild

- Rebuild the dev build when you:
  - Add or remove native modules (e.g. new Expo packages that require native code).
  - Change `app.json` / `app.config.js` in ways that affect the native project (e.g. plugins, bundle ID, icons).
- You do **not** need to rebuild for:
  - JS/TS changes.
  - Most config tweaks that don’t touch native code.

---

## 9. Optional: iOS

To build for **iOS** (Mac required for local simulator; physical device can use EAS):

```bash
eas build --profile development --platform ios
```

For a **simulator-only** dev build (no Apple Developer account needed for simulator):

- Add a profile in `eas.json` with `"ios": { "simulator": true }`, then:
  ```bash
  eas build --profile development --platform ios
  ```
  and choose the simulator target when prompted, or use a dedicated `development-simulator` profile.

---

## Quick reference

| Step | Command |
|------|--------|
| Install dev client | `npx expo install expo-dev-client` |
| Log in | `eas login` |
| Build Android dev APK | `eas build --profile development --platform android` |
| Start API | `cd C:\dev\Pep\api && npm run dev` |
| Start Metro | `cd C:\dev\Pep\apps\mobile && npx expo start` |
| Use app | Open “Pep” dev build on device; set API URL in app if needed |
