// electron-builder config (auto-detected by filename).
//
// Signs + notarizes ONLY when certificates are present in the environment
// (e.g. CI with repo secrets); otherwise it builds unsigned, so a local
// `npm run dist:mac` keeps working with no Apple/Windows account.
//
// Provide these as CI secrets to get signed installers:
//   macOS : CSC_LINK (base64 of Developer ID .p12), CSC_KEY_PASSWORD,
//           APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID   (for notarization)
//   Windows: WIN_CSC_LINK (base64 of Authenticode .pfx), WIN_CSC_KEY_PASSWORD

const signMac = !!process.env.CSC_LINK;
const signWin = !!process.env.WIN_CSC_LINK;
const notarize = !!(process.env.APPLE_ID || process.env.APPLE_API_KEY);

module.exports = {
  appId: 'com.figshop.bridge',
  productName: 'Figshop',
  asar: false,
  protocols: [{ name: 'Figshop', schemes: ['figshop'] }],
  directories: { output: 'dist' },
  publish: [{ provider: 'github', owner: 'Waqas-Baloch', repo: 'figshop' }],

  // When there's no real Developer ID, electron-builder leaves the app with a
  // broken default signature → macOS reports "damaged". Ad-hoc sign the packed
  // .app ourselves so it's the normal "unverified developer" prompt instead.
  // (Skipped when CSC_LINK is set — real signing handles it.)
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('  • ad-hoc signed', appPath);
  },

  mac: {
    category: 'public.app-category.graphics-design',
    // A signed .pkg gives a clean double-click install (no drag); unsigned it's
    // pointless (Gatekeeper blocks it harder than a .dmg), so only add it when signing.
    target: signMac ? ['dmg', 'pkg'] : ['dmg'],
    icon: 'assets/icon.png',
    extendInfo: { LSUIElement: true },
    ...(signMac
      ? {
          // Real Developer ID → harden + notarize for a warning-free install.
          hardenedRuntime: true,
          gatekeeperAssess: false,
          entitlements: 'build/entitlements.mac.plist',
          entitlementsInherit: 'build/entitlements.mac.plist',
          ...(notarize ? { notarize: true } : {}),
        }
      : {
          // No Developer ID → let electron-builder skip its own signing; the
          // afterPack hook above ad-hoc signs the app so it isn't "damaged".
          identity: null,
        }),
  },

  win: {
    target: ['nsis'],
    icon: 'assets/icon.png',
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true, // launches the helper right after install
    artifactName: 'Figshop-Setup-${version}.${ext}', // no spaces in the download URL
  },
};
