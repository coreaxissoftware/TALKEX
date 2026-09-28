# TalkEx — Google Play Store Deployment Guide (v1.0.0)

Complete, step-by-step guide to publish **TalkEx** to Google Play, tailored to
this project's actual setup.

| Fact | Value |
|---|---|
| **App name** | TalkEx |
| **Package (applicationId)** | `in.talkex.app`  ← permanent, set by the first AAB |
| **Version** | versionName `1.0.0`, versionCode `1` |
| **Signing keystore** | `frontend/android/talkex-release.keystore` (alias `talkex`) — **keep private & backed up** |
| **Firebase project (FCM)** | `talkex-app` |
| **Backend** | `https://api.talkex.in` (VPS) |
| **Privacy policy (live)** | `https://web.talkex.in/privacy-policy.html` |
| **Account type** | **Organization** (D-U-N-S) → can publish straight to Production (no 20-tester/14-day rule) |

Build the release artifacts any time with:
```bash
cd frontend
npm run build
npx cap sync android
cd android
./gradlew.bat bundleRelease assembleRelease   # .bat on Windows; ./gradlew on macOS/Linux
```
Outputs:
- **AAB (upload this to Play):** `frontend/android/app/build/outputs/bundle/release/app-release.aab`
- **APK (direct install/testing):** `frontend/android/app/build/outputs/apk/release/app-release.apk`

---

## 0. Prerequisites
- Google Play **Organization** developer account, verified (D-U-N-S done).
- The signed **AAB** (above).
- Graphics: `graphics/app-icon-512x512.png`, `graphics/feature-graphic-1024x500.png` (both ready).
- **2–8 phone screenshots** (you capture these — see §3).
- A **test login** the Google reviewer can use (phone + how they receive the OTP) — see §4 "App access". Critical, or the review is rejected.

---

## 1. Create the app
Play Console → **All apps → Create app**
- App name: **TalkEx**
- Default language: **English (United States)**
- App or game: **App**
- Free or paid: **Free**
- Tick the declarations → **Create app**

---

## 2. Store listing  (Grow → Store presence → Main store listing)
**Short description** (≤80 chars):
```
Secure chat, calls, status & music — end-to-end encrypted messaging.
```
**Full description** (≤4000 chars): use the full features text in
`PLAY_STORE_SETUP_GUIDE.md` §2 (chat / calls / status / music / planner /
groups / privacy). Ends with "Made with ❤️ by CoreAxis Software".

**Graphics:**
- App icon → `graphics/app-icon-512x512.png` (512×512, 32-bit PNG)
- Feature graphic → `graphics/feature-graphic-1024x500.png` (1024×500)
- Phone screenshots → §3

**Category & contact:**
- App category: **Communication**
- Email: `support@talkex.in` · Website: `https://talkex.in`

---

## 3. Screenshots (you take these on a phone)
Minimum **2**, recommended **4–8**. Open TalkEx and capture:
1. Chat list, 2. A conversation (E2EE label visible), 3. Status composer,
4. Photo editor (crop/filters), 5. Video call, 6. Music picker, 7. Theme picker.
Requirements: 16:9 or 9:16, shortest side 320–3840 px, PNG/JPEG.

---

## 4. App content  (Policy → App content) — fill EVERY section
- **Privacy policy:** `https://web.talkex.in/privacy-policy.html`
- **App access:** login is phone-OTP, so the reviewer needs access.
  Provide **test credentials + how to get the OTP** (e.g. a dedicated test
  number whose OTP you can read, or note the OTP delivery). Without this, review
  is rejected as "cannot access the app."
- **Ads:** No (unless you add ads).
- **Content rating:** complete the questionnaire (Communication app → usually
  Everyone/Teen). Submit to get the rating.
- **Target audience & content:** choose age groups (13+ recommended).
- **Data safety:** declare what's collected — phone number (account), messages
  (E2EE, not shared), media, device identifiers for push. Mark encryption in
  transit + that data isn't sold.
- **Government / financial / health / news:** No.

---

## 5. Create the Production release  (Release → Production → Create new release)
1. **App signing:** on the first release, accept **Play App Signing** (Google
   holds the app signing key; your `talkex-release.keystore` is the **upload
   key**). Keep that keystore + its passwords forever.
2. **Upload** `app-release.aab`.
3. **Release name:** `1.0.0` · **Release notes:** (from `PLAY_STORE_SETUP_GUIDE.md`
   "What's New").
4. **Save → Review release** → fix any errors it lists → **Start rollout to
   Production**.

> Tip: do a quick **Internal testing** release first (Release → Testing →
> Internal testing) to sanity-check the exact AAB on real devices with no review
> wait, then promote the same build to Production.

Review typically takes a few hours to a few days for a new listing.

---

## 6. After launch — updating the app
Every update MUST use a **higher versionCode**:
1. In `frontend/android/app/build.gradle` bump `versionCode` (e.g. 1 → 2) and
   optionally `versionName` (e.g. 1.0.0 → 1.0.1).
2. Rebuild the AAB (§ build command).
3. Play Console → Production → Create new release → upload the new AAB → notes →
   rollout.
- Signed with the **same** `talkex-release.keystore` (upload key) every time.

---

## 7. Keep these safe (losing them blocks all future updates)
- `frontend/android/talkex-release.keystore` **+ its passwords** (in
  `app/build.gradle`: store/key password `TalkEx@2026`, alias `talkex`).
- Firebase project **`talkex-app`** access (for FCM).
- Back the keystore up somewhere off this machine.

---

## 8. Common rejection reasons (avoid these)
- **No reviewer access** → always fill "App access" with a working test login/OTP.
- **Data safety mismatch** → declare phone number + messages honestly.
- **Broken privacy policy URL** → confirm `https://web.talkex.in/privacy-policy.html` loads.
- **Missing screenshots** → at least 2 phone screenshots.
- **Permissions not justified** → camera/mic/contacts are used by real features
  (calls, media, contact sharing); the store listing explains them.

---

## 9. Quick checklist
- [ ] Org account verified
- [ ] AAB built (`in.talkex.app`, vc 1)
- [ ] Icon + feature graphic uploaded
- [ ] 2+ screenshots uploaded
- [ ] Short + full description
- [ ] Privacy policy URL
- [ ] App access (reviewer test login + OTP)
- [ ] Content rating submitted
- [ ] Data safety completed
- [ ] Play App Signing accepted
- [ ] Production rollout started
- [ ] Keystore backed up
