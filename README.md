# Figshop — Edit Figma images in Photoshop, round-trip

Edit a Figma image in Photoshop like a **cross-app Smart Object**: send a picture
from Figma to Photoshop, make changes, save (⌘S), and Figma updates automatically.

```
┌──────────────┐   PNG of image    ┌───────────────┐   open .psd    ┌────────────┐
│ Figma plugin  │ ────────────────▶ │ Figshop bridge │ ─────────────▶ │ Photoshop  │
│ (sandbox UI)  │                   │ (Node, local)  │                │ (native)   │
│               │ ◀──────────────── │  file watcher  │ ◀───────────── │            │
└──────────────┘  WebSocket update  └───────────────┘  detect save     └────────────┘
   replace fill                      flatten PSD→PNG    (⌘S / Ctrl+S)
```

Your `.psd` for each image is kept in `~/.figshop/`, so re-editing the **same**
Figma image reopens **your layered PSD** (layers/masks intact). A flattened PNG is
what goes back to Figma.

## Why no "double-click in Figma"

Figma plugins run sandboxed and can't intercept canvas double-clicks. Instead you get
a native **"Edit in Photoshop"** button on the selected image (properties panel +
right-click menu), plus a one-click button in the plugin window. Same end result.

## Install — the app (recommended · macOS + Windows · zero config)

1. Install the helper app — **Figshop** (`.dmg` on macOS, `.exe` installer on Windows;
   see [Desktop app](#desktop-app--no-node-required-desktop) to build them).
2. Load the Figma plugin once (until it's published to the Figma Community):
   Figma **desktop app** ▸ `Plugins ▸ Development ▸ Import plugin from manifest…` ▸
   pick `figma-plugin/manifest.json`.

That's it. **No manual configuration:**

- The app **auto-detects the installed Photoshop** (any version, Mac or Windows) — no
  app name or path to set.
- It **flattens the saved PSD itself**, so you never touch Photoshop's "Maximize PSD
  Compatibility" setting.
- It **enables launch-at-login on first run**, so the bridge is always there. Toggle it
  off any time from the menu-bar icon.

### First-run helper install (driven from the plugin)

A Figma plugin is sandboxed and **cannot install or launch software itself** — that's an
OS rule, not a Figshop limitation. So the first time you click **Edit** with no helper
running, the plugin shows a **"Install Figshop helper"** button:

1. Click it → the OS-correct installer downloads (`.dmg` / `.exe`).
2. Double-click the installer — it installs, launches, and registers autostart +
   the `figshop://` scheme automatically (the Windows installer launches itself; on
   macOS, drag to Applications and open once).
3. The plugin **auto-reconnects** and your edit proceeds. Every later session just works.

> Wire-up: set `RELEASES_URL` in [`figma-plugin/ui.html`](figma-plugin/ui.html) to your
> published installers (e.g. a GitHub Releases page — the CI workflow produces both).

## Use it

1. In Figma, select an image and click **Edit selected image in Photoshop** (or the
   **Edit in Photoshop** button that appears on the layer's right-click / properties).
2. Photoshop opens the image. Edit, then **save** (⌘S / Ctrl+S).
3. Figma updates the image instantly. Repeat — your PSD layers persist between edits.

**Reset** re-imports a fresh copy from Figma, discarding the local PSD edits.

## Run from source (developers)

Start the bridge with any of these (all run the same core):

| How | Notes |
|-----|-------|
| **Double-click `bridge/start-figshop.command`** | one session, no terminal (macOS) |
| **Double-click `bridge/install-autostart.command`** | macOS LaunchAgent, runs at login forever |
| `cd bridge && npm install && npm start` | any platform with Node |

Optional overrides via env or `~/.figshop/config.json` — none are required:
`FIGSHOP_PORT=3900`, `PHOTOSHOP_APP="<app name (mac) / Photoshop.exe path (win)>"`.

## Layout

| Path | What |
|------|------|
| `bridge/bridge.js` | Bridge core: WebSocket + file watcher, PSD⇄PNG, cross-platform Photoshop launch |
| `bridge/server.js` | CLI wrapper around the core |
| `desktop/main.js` | Electron menu-bar app (bundles Node; macOS + Windows) |
| `figma-plugin/code.js` | Figma main thread: export, apply fills, relaunch button |
| `figma-plugin/ui.html` | Iframe: WebSocket client to the bridge |
| `~/.figshop/` | Per-node `.psd` store + `index.json` + `config.json` |

## Desktop app — no Node required (`desktop/`)

`desktop/` is an **Electron menu-bar app** that bundles its own Node runtime and runs
the exact same bridge core. End users just install it — no terminal, no `npm`, no Node.

```bash
cd desktop
npm install        # downloads Electron (~100 MB, once)
npm run start      # dev: launches the tray app on this machine
npm run dist:mac   # builds dist/Figshop-<version>-arm64.dmg
npm run dist:win   # builds the Windows NSIS installer (.exe)  — run on Windows
```

The menu-bar icon shows bridge status and offers **Start/Stop**, **Open at login**,
**Open log…**, **Open PSD folder…**, and **Quit**.

### Releasing both platforms (CI)

You can only build the installer for the OS you're on (cross-building Windows from macOS
needs wine and isn't reliable), so [`.github/workflows/build.yml`](.github/workflows/build.yml)
builds each on its own runner:

- **Run from the Actions tab** → uploads the `.dmg`/`.exe` as artifacts.
- **Push a tag `vX.Y.Z`** → also publishes a **GitHub Release** with the installers
  attached. Point `RELEASES_URL` in [`figma-plugin/ui.html`](figma-plugin/ui.html) at
  that release page and the plugin's install button is live.

```bash
git remote add origin https://github.com/Waqas-Baloch/figshop.git
git push -u origin main
git tag v0.1.0 && git push origin v0.1.0   # → CI builds + publishes the Release
```

### Code-signing (optional, removes first-launch warnings)

Builds are **unsigned by default** (works with no Apple/Windows account; users do a
one-time right-click ▸ Open / "Run anyway"). Add these **repo secrets** and the same CI
**signs + notarizes automatically** — and macOS additionally produces a double-click
`.pkg`:

| Platform | Secrets |
|----------|---------|
| macOS | `MAC_CSC_LINK` (base64 of Developer ID `.p12`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK` (base64 of Authenticode `.pfx`), `WIN_CSC_KEY_PASSWORD` |

The logic lives in [`desktop/electron-builder.js`](desktop/electron-builder.js): present
certs → signed; absent → unsigned. macOS build is **arm64** (add `x64`/`universal` for
Intel). The Figma plugin ships separately via the Figma Community once published.

Why Electron and not Tauri: the bridge is Node + a native canvas module
(`@napi-rs/canvas`). Electron *is* Node and the module is N-API-based, so it bundles and
loads on both platforms with **no rebuild**. `desktop/bridge.mjs` is generated from
`bridge/bridge.js` by `npm run sync-core` — single source of truth.

## Known limits

- The image returns to Figma **flattened** (Figma can't host a live PSD) — your layers
  still persist locally in `~/.figshop/` for the next edit.
- Highest fidelity comes from Photoshop's own composite; the self-flatten fallback covers
  common layers/opacity/blends but not every layer *effect* (e.g. some adjustment layers).
- Export resolution is the Figma node size × 2; resizing the canvas in Photoshop is
  absorbed by the fill's scale mode.
