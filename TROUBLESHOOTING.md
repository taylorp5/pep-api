# Pep – API & “Stuck on loading” troubleshooting

The mobile app calls the **Pep API** on **port 3001**. If you start the wrong project or the wrong server, generation will hang or time out.

---

## Expo Go on your Android phone (physical device)

On a **physical Android phone** with **Expo Go**, the phone must reach your PC over Wi‑Fi. The app uses the URL in `.env` — it does **not** use `10.0.2.2` (that’s only for the emulator).

1. **Same Wi‑Fi**  
   Phone and PC must be on the **same Wi‑Fi network**.

2. **Get your PC’s IP (Windows)**  
   In PowerShell or CMD:
   ```powershell
   ipconfig
   ```
   Find **IPv4 Address** under your **Wi‑Fi** adapter (e.g. `10.0.0.9` or `192.168.1.5`). Use that number.

3. **Set the API URL in the app**  
   In the Pep project, edit **`apps/mobile/.env`** (or `mobile/.env` if your app is there):
   ```env
   EXPO_PUBLIC_API_URL=http://YOUR_PC_IP:3001
   ```
   Example: if your IP is `10.0.0.9`:
   ```env
   EXPO_PUBLIC_API_URL=http://10.0.0.9:3001
   ```
   No trailing slash. Use the real IP from step 2.

4. **Start the API on your PC**  
   In a terminal on your PC:
   ```powershell
   cd C:\dev\Pep\api
   npm run dev
   ```
   You should see: `API running on http://0.0.0.0:3001`.

5. **Restart Expo so .env is loaded**  
   The project has `app.config.js` that loads `.env` from **`apps/mobile`** when Expo starts, so you can run Expo from any folder. You still must:
   - Create or edit **`C:\dev\Pep\apps\mobile\.env`** with one line: `EXPO_PUBLIC_API_URL=http://YOUR_PC_IP:3001` (use your real IP from step 2, e.g. `http://10.0.0.9:3001`). No spaces around `=`, no trailing slash.
   - Stop any running Expo (Ctrl+C), then run: `npx expo start --clear` (you can run from `C:\dev\Pep\apps\mobile` or from `C:\dev\Pep` — `app.config.js` loads `.env` from `apps/mobile`).
   - In Expo Go on the phone, reload the app (shake → Reload) or scan the QR code again.

   **If you still see API: http://10.0.2.2:3001:** Make sure `.env` is saved in `apps\mobile` with the exact line `EXPO_PUBLIC_API_URL=http://10.0.0.9:3001` (or your IP). Then fully stop Expo (Ctrl+C) and run `npx expo start --clear` again.

   **In the app:** Use the **Test** button next to the API URL. **Connection OK** = try Generate again; **Connection failed** = phone cannot reach your PC (firewall, wrong IP, or API not running).

6. **Test in the phone’s browser (optional)**  
   On your phone, open Chrome and go to `http://YOUR_PC_IP:3001` (same URL as in `.env`). If the API is running and the network is correct, you’ll see a response. If that fails, the app will fail too — fix firewall/network first.

**If “Test” keeps failing:** allow port **3001** in Windows Firewall (or temporarily turn the firewall off to test), and confirm your PC’s Wi‑Fi IPv4 matches the URL (run `ipconfig` again).

---

## 1. Start the correct project and API

You must run the **Pep API** from the **Pep repo**, not another project.

1. **Open a terminal and go to the Pep repo:**
   ```powershell
   cd C:\dev\Pep
   ```

2. **Start the Pep API (port 3001):**
   ```powershell
   cd api
   npm run dev
   ```

3. **You should see something like:**
   ```
   API running on http://0.0.0.0:3001
   Accessible from network at http://<your-ip>:3001
   ```

If you see **Next.js** or **“Local: http://localhost:3000”**, you are in the wrong project or ran the wrong command. Stop that and run the commands above from `C:\dev\Pep\api`.

---

## 2. Check the API is reachable

- **From your PC:** open a browser and go to **http://localhost:3001**  
  You should get a response (e.g. “OK” or a simple message), not “can’t connect”.

- **From the app:**  
  - **Android emulator:** the app uses `http://10.0.2.2:3001` (host machine).  
  - **Physical device:** the app uses the URL from `.env` (e.g. `http://10.0.0.9:3001`).  
  Your PC and phone must be on the same Wi‑Fi, and the API must be running as in step 1.

---

## 3. .env (mobile app)

- **Location:** `C:\dev\Pep\apps\mobile\.env` (or `C:\dev\Pep\mobile\.env` if your app lives there).

- **Physical device:** set your PC’s LAN IP, e.g.:
  ```env
  EXPO_PUBLIC_API_URL=http://10.0.0.9:3001
  ```
  (Replace with your PC’s IP from `ipconfig` – IPv4 under your Wi‑Fi adapter.)

- **Android emulator:** you can keep the same .env; the app will use `10.0.2.2:3001` automatically when it detects the emulator.

After changing .env, restart the Expo app (reload or restart `npx expo start`).

---

## 4. Quick checklist

| Step | What to do |
|------|------------|
| 1 | Terminal: `cd C:\dev\Pep\api` |
| 2 | Run: `npm run dev` |
| 3 | See: “API running on http://0.0.0.0:3001” |
| 4 | Browser: open http://localhost:3001 and confirm it loads |
| 5 | Mobile app: try “Generate” or “Daily” again |

If the API is running on 3001 and the app is using the correct URL (10.0.2.2 for emulator, your LAN IP for device), the “stuck on loading” / timeout should go away.

---

## 5. If it still times out

- **Firewall:** allow port **3001** (Windows Firewall or antivirus).
- **Same network:** phone/emulator and PC on the same Wi‑Fi.
- **Correct URL:** on a physical device, `EXPO_PUBLIC_API_URL` must be `http://<YOUR_PC_IP>:3001` (no trailing slash).
