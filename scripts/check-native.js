#!/usr/bin/env node
/**
 * Pre-launch check for native modules
 * Ensures better-sqlite3 is compiled for Electron's Node version
 */

const { execSync } = require('child_process');
const path = require('path');

try {
  // Try to load better-sqlite3 with Electron's Node
  const electronPath = path.join(__dirname, '../node_modules/.bin/electron');

  // Quick check: try to require better-sqlite3 in Electron context
  const result = execSync(
    `${electronPath} -e "try { require('better-sqlite3'); process.exit(0); } catch(e) { console.error(e.message); process.exit(1); }"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
  );

  console.log('[check-native] better-sqlite3 OK');
} catch (error) {
  const stderr = error.stderr || error.message || '';

  if (stderr.includes('NODE_MODULE_VERSION') || stderr.includes('was compiled against')) {
    console.log('[check-native] better-sqlite3 needs rebuild for Electron...');

    try {
      execSync('npx electron-rebuild -f -w better-sqlite3', {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
      });
      console.log('[check-native] Rebuild complete');
    } catch (rebuildError) {
      console.error('[check-native] Rebuild failed:', rebuildError.message);
      process.exit(1);
    }
  } else {
    // Some other error, might be fine
    console.log('[check-native] Check inconclusive, continuing...');
  }
}
