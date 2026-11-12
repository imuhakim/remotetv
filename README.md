# RemoteTV

An ad-free, open-source TV remote and caster. It is a rebuild of a typical "TV Remote & Screen Mirror" app, with every premium feature free.

![RemoteTV](public/icon.svg)

**Supported TVs:** Sony BRAVIA (IP control), Android TV / Google TV (Remote v2, the same protocol as Google's app), Roku, LG webOS and Samsung Tizen. **Casting** uses DLNA and DIAL, which most smart TVs support.

There are two ways to use it:

| | **Android app (APK)**, no PC needed | **Hub + browser** |
|---|---|---|
| Install | Download the APK from [Releases](https://github.com/imuhakim/remotetv/releases/latest) | Run `npm start` on a PC or Raspberry Pi, then open the address on the phone |
| TVs | Sony BRAVIA, Android/Google TV, Roku | Also LG webOS and Samsung Tizen |
| Cast from phone | Yes: the phone streams the file to the TV itself | Yes: the file is uploaded to the hub |

```
APK:  Phone app ─────────────────────────────► TV (Sony REST/IRCC · Android TV v2 TLS · Roku ECP · DLNA · DIAL)
Hub:  Phone (PWA) ─HTTP/WS─► RemoteTV hub ───► TV (the above + LG SSAP · Samsung WS)
```

Both use the same UI (`public/`). The APK runs the TV drivers inside the app (`public/native/`) through a small native plugin for raw TLS, SSDP/mDNS, Wake-on-LAN and a file server (`android/app/src/main/java/.../RemoteTvPlugin.java`). GitHub Actions builds a new APK on every push to `main`.

See [docs/EVIDENCE.md](docs/EVIDENCE.md) for the analysis of the original app and the comparison table.

## Features

- **Remote:** touchpad (swipe, tap = OK, hold = Back) or D-pad, volume and channel rockers with hold-to-repeat, live volume level, mute, home, back, all-apps sheet, input list, media keys, number pad, colour keys, info and guide.
- **Quick access:** your own app shortcut row. Opens Netflix, YouTube, Prime Video, Disney+, Spotify or any app the TV reports.
- **More menu:** *Open on the TV* (paste a link, or Share › RemoteTV from YouTube/Chrome), *Sleep timer*, *Scenes* (one tap runs steps such as power → wait → volume +5 → open YouTube), *Air Mouse* (hold and turn the phone to move), and *Simple mode* with big buttons.
- **Shop TV (with the owner's permission):** in the TV list, turn on *Shop / someone else's TV* before adding it; the TV is forgotten automatically after 12 hours. On phones with an IR blaster, *Infra-red* works for **Sony, Samsung and LG** TVs without the shop's Wi-Fi or any pairing.
- **Advanced mode (ADB, optional, Android app):** after turning on debugging in the TV's Developer options, see the **live TV screen** on the phone and tap or swipe on it, save **screenshots**, open or force-stop **TV apps**, check **TV health** (memory, storage, temperature, uptime), and run the **sleep timer on the TV itself**. Network debugging has no password, so only use it on your home Wi-Fi and turn it off when not needed.
- **Now open:** shows which app is on screen (Android / Google TV).
- **Keyboard:** type into the TV's search box (Sony, LG, Samsung, Roku).
- **Voice:** speak a search; it opens TV search and types the words for you. Needs the HTTPS address.
- **Cast:** push photos, videos and audio from the phone to the TV's built-in player (DLNA). Open YouTube or Shorts links on the TV (DIAL). Play any direct media URL. Pause, resume and stop from the phone.
- **Power:** off and on (Sony REST, Android TV), plus Wake-on-LAN from standby.
- **Settings:** haptics, smooth press, keep screen awake, theater mode, swipe sensitivity, saved TVs. Everything is unlocked.
- **Extras:** auto-discovery (SSDP and mDNS), macros API, desktop keyboard shortcuts, optional hub PIN, offline app shell.

## Install the Android app (no PC)

1. On your phone, open **https://github.com/imuhakim/remotetv/releases/latest**.
2. Download **RemoteTV-v1.1.x.apk** and open it. Allow "Install unknown apps" for your browser when Android asks.
3. Open RemoteTV, tap **Tap to connect your TV**, then **Scan network**, and pick your TV.
   - **Android TV** (e.g. Sony KD-55X7500F): type the 6-character code shown on the TV.
   - **Sony BRAVIA (IP control)**: set a Pre-Shared Key on the TV first (see below). This adds the keyboard, the HDMI input list and power-on.
   - **Sony TV · infra-red (no Wi-Fi)**: appears only on phones with an IR blaster (many Xiaomi/Redmi/POCO, some Huawei/Honor). Point the top of the phone at the TV. It sends Sony SIRC codes at 40 kHz, so it works without Wi-Fi or pairing and can switch the TV on, but it has buttons only: no volume level, app list or keyboard.

Panduan ringkas: buka pautan Releases di atas di telefon, muat turun fail `.apk`, pasang, kemudian tekan **Scan network** dan masukkan kod yang keluar di TV.

APK signing: CI generates a signing key on its first run and keeps it in the GitHub Actions cache, so new versions install over old ones. No key is stored in this repository. GitHub evicts a cache that is unused for 7 days; if that happens, the next APK has a new key and you must uninstall the old app once. To keep one key permanently, add the repository secrets `ANDROID_KEYSTORE_B64` (a base64 PKCS12 keystore), `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`.

### Is the APK safe to install?

The repository is public, so anyone can read the code, but only the owner can change it: others can only fork it or open a pull request, and pull requests never trigger the APK build. Each release is built by GitHub Actions from a commit on `main`. Every action in the workflow is pinned to a fixed commit, and the run records a signed [build attestation](https://github.com/imuhakim/remotetv/attestations) that ties the APK file to that commit. Android also refuses to update the app with an APK signed by a different key.

To check a downloaded APK on a PC: `gh attestation verify RemoteTV-v1.1.N.apk -R imuhakim/remotetv`. Download only from this repository's Releases page.

The app asks only for network, Wi-Fi multicast, vibration and infra-red permissions. It has no access to contacts, SMS, storage (files are opened through the system picker), location, the microphone or the camera.

## Quick start (hub version)

```bash
git clone https://github.com/imuhakim/remotetv.git
```

```bash
cd remotetv && npm install
```

```bash
npm start
```

The hub prints two addresses:

```
Phone (same Wi-Fi): http://192.168.0.x:8080
HTTPS (voice + wake lock): https://192.168.0.x:8443
```

1. Open the address on your phone. Choose **Add to Home screen** to install it.
2. Tap **Tap to connect your TV**, then **Scan network**, and pick your TV.
3. **Android / Google TV:** type the code shown on the TV. **Sony BRAVIA (IP control):** on the TV, go to *Settings › Network › Home network › IP control*. Set *Authentication* to **Normal and Pre-Shared Key** and set a key, then enter that key. **LG / Samsung:** accept the prompt on the TV. **Roku:** no pairing needed.

Tip for Sony Android TVs such as the KD-55X7500F: you can add the same TV twice. Use **Android TV** for live volume and power events, and **Sony BRAVIA** for the keyboard, the HDMI input list and power-on.

### Panduan ringkas (Bahasa Melayu)

1. Pasang [Node.js](https://nodejs.org) 18+ pada PC atau laptop yang guna Wi-Fi sama dengan TV.
2. Jalankan `npm install`, kemudian `npm start`.
3. Di telefon, buka alamat `http://192.168.x.x:8080` yang dipaparkan, kemudian pilih *Add to Home screen*.
4. Tekan **Scan network** dan pilih TV. Untuk Android TV, masukkan kod yang keluar di TV.
5. Untuk suara (mic) dan skrin sentiasa hidup, guna alamat `https://…:8443` dan terima amaran sijil.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HTTPS_PORT` | `8443` | HTTPS port with a self-signed certificate (`0` disables it) |
| `REMOTETV_PIN` | none | Require a PIN for the API and WebSocket |
| `REMOTETV_DATA` | `./data` | Where paired TVs, certificates and cast files are stored |

Pairing secrets live only in `data/store.json`, which is git-ignored. The API never returns PSKs or certificates.

## API

All endpoints are JSON under `/api`.

| Method | Path | Body |
|---|---|---|
| GET | `/discover` | |
| GET/POST | `/devices` | `{host, type, name, psk?, mac?}` |
| POST | `/devices/:id/connect` | |
| POST | `/devices/:id/pair` | `{code}` |
| POST | `/devices/:id/key` | `{key, mode?: short\|start\|end}` |
| POST | `/devices/:id/text` | `{text}` |
| POST | `/devices/:id/volume` | `{level}` |
| GET | `/devices/:id/apps` | |
| POST | `/devices/:id/launch` | `{id}` (app id or name) |
| GET/POST | `/devices/:id/inputs`, `/input` | `{id}` |
| POST | `/devices/:id/wake` | |
| POST | `/devices/:id/macro` | `{steps: [{key}\|{text}\|{app}, delay?]}` |
| POST | `/devices/:id/cast/upload` | raw file body plus an `x-filename` header |
| POST | `/devices/:id/cast/url` | `{url, mime?}` |
| POST | `/devices/:id/cast/youtube` | `{url}` |
| POST | `/devices/:id/cast/control` | `{action: pause\|resume\|stop\|seek\|volume, value?}` |

Key names: `up down left right ok back home menu apps vol_up vol_down mute ch_up ch_down power power_off input info guide settings search play pause play_pause stop rewind forward prev next 0-9 red green yellow blue`.

Live TV state (power, volume, current app) and pairing prompts are pushed over the WebSocket at `/ws`.

## Tests

```bash
npm test
```

The tests run the hub against a fake Sony BRAVIA. They cover:

- PSK rejection
- the IRCC codes learned from the TV and the built-in fallback codes
- text, volume, the app list and app launch
- DLNA `SetAVTransportURI`/`Play`, status and controls
- YouTube through DIAL
- phone upload streaming and macros.

The Android TV, LG and Samsung drivers follow the libraries and protocols listed in [docs/EVIDENCE.md](docs/EVIDENCE.md). They have not been tested against real sets yet.

## Roadmap

- LG and Samsung drivers inside the APK (they need WebSockets that accept the TV's self-signed certificate).
- Voice search inside the APK (Android WebView has no speech recognition).
- Screen mirroring from the phone. This needs a native app, using Android `MediaProjection` with Cast or Miracast.
- Text entry over the Android TV Remote v2 IME channel.

## License

MIT
