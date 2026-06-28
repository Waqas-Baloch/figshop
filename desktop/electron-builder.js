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

  mac: {
    category: 'public.app-category.graphics-design',
    // A signed .pkg gives a clean double-click install (no drag); unsigned it's
    // pointless (Gatekeeper blocks it harder than a .dmg), so only add it when signing.
    target: signMac ? ['dmg', 'pkg'] : ['dmg'],
    icon: 'assets/icon.png',
    extendInfo: { LSUIElement: true },
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // No Developer ID available → explicitly skip signing so the build succeeds.
    ...(signMac ? {} : { identity: null }),
    ...(notarize ? { notarize: true } : {}),
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
