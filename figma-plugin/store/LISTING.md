# Figma Community listing — Figma To Photoshop

Copy/paste the fields below when you publish. Assets are in this folder:
`icon-128.png` (plugin icon) and `cover-1920x960.png` (cover art). Regenerate with
`make-assets.mjs`.

---

## Name
```
Figma To Photoshop
```

## Tagline  (one line, ~½ sentence)
```
Edit any Figma image in Photoshop — your changes sync back automatically.
```

## Description  (paste into the description box)
```
Figma To Photoshop turns any image in your Figma file into a cross-app Smart
Object. Send it to Adobe Photoshop in one click, make your edits, hit Save — and
Figma updates instantly. No exporting, re-importing, or shuffling files around.

How it works
1. Select an image in Figma.
2. Click “Edit in Photoshop” — on the layer’s right-click menu, or in the panel.
3. Photoshop opens your image. Edit it however you like.
4. Save (⌘S / Ctrl+S). Your Figma image updates automatically.

Your Photoshop document is kept between edits — reopen the same image later and
your layers, masks, and adjustments are still there, just like a Smart Object.

Highlights
• Works on macOS and Windows
• Auto-detects your installed Photoshop — nothing to configure
• Layers preserved between edits (a local PSD per image)
• One-click round-trip — no manual export/import

Note: Figma plugins can’t launch desktop apps on their own, so this uses a small
free companion app that bridges Figma and Photoshop on your computer. The plugin
walks you through the one-time install the first time you click Edit.
```

## Tags  (pick the most relevant; Figma allows up to ~12)
```
photoshop, image editing, smart object, export, round-trip, workflow,
productivity, design tools, raster, adobe, sync, assets
```

## Support / feedback
```
https://github.com/Waqas-Baloch/figshop
```

---

## How to publish

1. In the **Figma desktop app**, open any file.
2. **Menu ▸ Plugins ▸ Development ▸ Figma To Photoshop ▸ Publish…**
   (if it isn’t listed: **Import plugin from manifest…** → `figma-plugin/manifest.json` first).
3. Fill in the fields above. Upload:
   - **Plugin icon** → `icon-128.png`
   - **Cover art** → `cover-1920x960.png`
4. Set creator, category (Productivity / Design tools), and a support contact.
5. **Submit for review.** Figma reviews submissions (usually a few days). Once
   approved, anyone can click **Add** from the Community — no manifest import.

### Before/while you submit
- Mention the companion app clearly (reviewers test plugins). The download lives at
  https://github.com/Waqas-Baloch/figshop/releases/latest.
- The plugin only contacts `localhost:3900` (declared in the manifest) — no external
  servers, which keeps review straightforward.
- Consider notarizing the companion app first so reviewers/users don’t hit the macOS
  “unverified developer” prompt.
