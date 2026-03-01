# Pep API

Backend for the Pep mobile app (daily pep, custom pep, TTS).

## Run the server

```bash
npm run dev
```

Listens on `http://localhost:3001`. The mobile app must reach this URL:

- **Android emulator:** use `10.0.2.2:3001` (already set in the app).
- **Physical device (Expo Go):** use your computer’s LAN IP (e.g. `http://192.168.1.5:3001`). Set it in `apps/mobile/screens/HomeScreen.tsx` in `getApiUrl()`.

Ensure `OPENAI_API_KEY` is set in a `.env` file in this directory.

## Audio normalization (optional)

TTS output is normalized to **-16 LUFS** (speech) with no clipping and preserved dynamic range. This requires **FFmpeg** on the server (in `PATH`). If FFmpeg is missing or fails, audio is returned unchanged.
