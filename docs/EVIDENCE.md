# Evidence: what the existing remote app does, and what RemoteTV fixes

## 1. Sources and their limits

| Source | What it gives | Authority |
|---|---|---|
| 6 phone screenshots of the current app (Remote, Mirroring and Settings tabs), taken 17:03 | Visible features, layout, ads, paywalls | Observed UI |
| A LAN scan run by the RemoteTV hub on 2026-11-10 | Which protocols the user's TV exposes | Observed network |
| Public protocol docs and open-source libraries (section 4) | How each feature is done on the wire | External reference |

Not available:

- **No APK and no `adb`.** The working folder was empty and no Android device was attached, so REA could not decompile the shipped app or trace it at runtime. Section 3 infers the protocols from the UI and the LAN scan. It does not come from the app's code.
- **No direct calls to the TV.** A read-only probe of the TV's REST API was blocked by the session's permission policy, so this session never sent a key to the real TV.
- **The 7th screenshot does not belong to the remote app.** It shows a chat group profile, was not used, and none of its content is in this repository.

## 2. Findings from the screenshots

### Remote tab

- A full-width **banner ad** sits at the top, above the device pill. The ad was for an AI assistant, captioned in Malay as fast part-time work.
- The device pill shows `KD-55X7500F` with a green connected dot. Next to it are a **crown (upsell)** and a power button.
- The Quick Access row holds Netflix, YouTube, Prime, Disney+ and Spotify.
- A large **"SWIPE · TAP" touchpad** is the only navigation. No D-pad is shown in this layout.
- The bottom cluster has a VOL rocker showing the live level `24` with a fill bar, plus keyboard, home, apps, sound, mic (accent), back and a CH rocker.
- Missing: media keys (play/pause/rewind/forward), number pad, colour keys, input/source selection and an info/guide key.

### Mirroring tab

- A **native ad card ("Install")** sits between the main actions and Cast Media, and takes about 30% of the screen.
- Cast Media has Videos, Photos and Audio.
- Cast Web has YouTube, Web Video and Shorts.
- An **"Upgrade to Premium" banner** says the free tier has ads, **no sound while mirroring** and **no browser mirroring**.

### Settings tab

- An **"Unlock Premium" card** comes first. It sells ad-free remote and mirroring, ad-free photo/video cast, and **"Stay connected in background"**, which means the free tier drops the connection in the background.
- Remote layout: Navigation = Touchpad and Quick Access = Applications. Both are configurable.
- Remote behaviour: haptic feedback, smooth press, keep screen awake and theater mode.
- Devices: connected-device history (KD-55X7500F) and save connected devices.
- Help and About: language, FAQ, contact, feedback, share and rate.

### Summary

The app's core remote is good, but the free experience has these problems:

- ads on every tab, including a banner on the remote itself
- basic quality features (staying connected, ad-free cast) are paywalled
- several remote keys are missing.

## 3. Protocol evidence for the user's TV (KD-55X7500F)

The hub's discovery scan on the same Wi-Fi returned:

```
KD-55X7500F  BRAVIA 4K GB ATV3  <tv-ip>  · cast ready
  protocols: Sony BRAVIA (ScalarWebAPI over SSDP), Android / Google TV (mDNS _androidtvremote2._tcp)
  DLNA MediaRenderer with AVTransport: yes
(plus one other Android TV box on the same network)
```

From this scan:

- **Android TV Remote v2** (TLS on 6466, pairing on 6467) is advertised. This is the protocol of Google's own TV remote app. It gives keys, app links and live **volume/power/current-app events**. The live "VOL 24" in the old app fits this protocol or Sony's `audio.getVolumeInformation`; which one the app uses is an inference that could not be checked without the APK.
- **Sony ScalarWebAPI + IRCC-IP** is advertised. It adds text entry (`appControl.setTextForm`), the app list with icons, input switching, absolute volume and power-on.
- **A DLNA renderer** is present. Photos, videos and audio can be pushed to the TV's own player with no app installed on the TV.
- **DIAL** lets the TV's YouTube app open a given video, which covers "Cast YouTube" and "Shorts".

## 4. Open-source references used

| Need | Project | How it was used |
|---|---|---|
| Android TV Remote v2 | [louis49/androidtv-remote](https://github.com/louis49/androidtv-remote) (npm `androidtv-remote`) | Direct dependency |
| Android TV Remote v2 (reference) | [tronikos/androidtvremote2](https://github.com/tronikos/androidtvremote2), [kud/androidtv-remote](https://github.com/kud/androidtv-remote) | Protocol cross-check |
| Sony IRCC-IP / REST | [Sony BRAVIA Pro docs](https://pro-bravia.sony.net/remote-display-control/), [BrandonDusseau/braviaproapi](https://github.com/BrandonDusseau/braviaproapi), [trugamr/bravia](https://pkg.go.dev/github.com/trugamr/bravia), [philpennock/tv-sony](https://github.com/philpennock/tv-sony), [avinash311/sony-tv-remote](https://github.com/avinash311/sony-tv-remote) | PSK auth, IRCC codes, `/sony/IRCC` fallback path |
| LG webOS | [hobbyquaker/lgtv2](https://github.com/hobbyquaker/lgtv2) | SSAP register and pointer socket |
| Samsung Tizen | [Toxblh/samsung-tv-control](https://github.com/Toxblh/samsung-tv-control) | `ms.remote.control` WebSocket messages |
| Roku | Roku External Control Protocol docs | keypress, launch and query/apps |
| Ecosystem | [vitalets/awesome-smart-tv](https://github.com/vitalets/awesome-smart-tv) | Survey |

## 5. Old app vs RemoteTV

| | Old app (free) | RemoteTV |
|---|---|---|
| Ads | Banner on the remote, native ad on cast | **None** |
| Premium paywall | Background connection, ad-free cast, mirroring sound | **Everything free and open source** |
| Navigation | Touchpad | Touchpad (swipe, tap = OK, hold = Back, adjustable sensitivity) **or D-pad** |
| Media keys / numpad / colour keys / input | Not visible | **Yes** |
| Live volume level | Yes | Yes (Android TV events and Sony polling) |
| Keyboard to TV | Yes | Yes (Sony, LG, Samsung, Roku) |
| Voice | Mic button | Speech to text, then opens TV search and types it (HTTPS) |
| All apps / inputs | Apps button | The TV's real app list with icons, plus an HDMI input list (Sony) |
| Cast photo/video/audio | Yes, with ads | DLNA push straight from the phone, with now-playing controls |
| Cast YouTube / Shorts | Yes | DIAL or native app link |
| Power on from standby | Not shown | Sony `setPowerStatus` and **Wake-on-LAN** |
| Macros | No | `POST /api/devices/:id/macro` |
| Brands | Unknown | Sony, Android/Google TV, Roku, LG webOS, Samsung Tizen |
| Desktop control | No | Keyboard shortcuts in any browser |
| Screen mirroring | Yes (Premium for sound) | **Not included.** A browser cannot capture the phone screen. See the roadmap in the README. |
