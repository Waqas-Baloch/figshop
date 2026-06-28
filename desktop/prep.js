// Cross-platform build prep: sync the bridge core + generate icons.
//
// Runs as a plain `node prep.js` so it can be chained as `node prep.js &&
// electron-builder …`. (On Windows, `npm run prep && …` does NOT chain — invoking
// npm.cmd doesn't return control to run the `&&` command — so we avoid that.)
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

fs.copyFileSync('../bridge/bridge.js', 'bridge.mjs');
execFileSync(process.execPath, ['make-icons.mjs'], { stdio: 'inherit' });
console.log('prep: synced bridge.mjs + generated icons');
