#!/usr/bin/env node

/**
 * Syncs package.json version from the latest git tag.
 * Git tags are the source of truth for versioning.
 * Runs automatically before build/dev/dist scripts.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

try {
  // Get the latest version tag (e.g. "v2.5.2" → "2.5.2")
  const tag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
  const version = tag.replace(/^v/, '');

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.log(`[sync-version] Skipping: tag "${tag}" is not a valid semver`);
    process.exit(0);
  }

  if (pkg.version === version) {
    process.exit(0);
  }

  console.log(`[sync-version] ${pkg.version} → ${version} (from tag ${tag})`);
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
} catch (err) {
  // No git tags or not a git repo — keep existing version
  console.log('[sync-version] No git tags found, keeping current version');
}
