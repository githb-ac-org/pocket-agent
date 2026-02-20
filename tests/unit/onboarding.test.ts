/**
 * Unit tests for the onboarding flow
 *
 * Tests the setup wizard's logic: keychain → permissions → auth → success,
 * including platform gating, permission status rendering decisions,
 * and navigation state management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Electron mocks ──────────────────────────────────────────────────────────

const mockGetMediaAccessStatus = vi.fn(() => 'granted');
const mockIsTrustedAccessibilityClient = vi.fn(() => true);
const mockOpenExternal = vi.fn();
const mockIsEncryptionAvailable = vi.fn(() => true);
const mockEncryptString = vi.fn((v: string) => Buffer.from('enc:' + v));
const mockDecryptString = vi.fn((b: Buffer) => b.toString().replace('enc:', ''));

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (...a: unknown[]) => mockGetMediaAccessStatus(...a),
    isTrustedAccessibilityClient: (...a: unknown[]) => mockIsTrustedAccessibilityClient(...a),
  },
  shell: {
    openExternal: (...a: unknown[]) => mockOpenExternal(...a),
  },
  safeStorage: {
    isEncryptionAvailable: () => mockIsEncryptionAvailable(),
    encryptString: (v: string) => mockEncryptString(v),
    decryptString: (b: Buffer) => mockDecryptString(b),
  },
}));

// ── OS / filesystem mocks ───────────────────────────────────────────────────

const mockPlatform = vi.fn(() => 'darwin');
vi.mock('os', () => ({
  platform: () => mockPlatform(),
  homedir: () => '/mock/home',
}));

const mockAccessSync = vi.fn();
vi.mock('fs', () => ({
  accessSync: (...a: unknown[]) => mockAccessSync(...a),
  constants: { R_OK: 4 },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'authorized'),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  isMacOS,
  getPermissionsStatus,
  openPermissionSettings,
  checkPermission,
  getPermissionStatus,
} from '../../src/permissions/macos';
import type { PermissionType, PermissionStatus } from '../../src/permissions/macos';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The three permissions shown in the onboarding step */
const ONBOARDING_PERMISSIONS: PermissionType[] = [
  'full-disk-access',
  'accessibility',
  'screen-recording',
];

/**
 * Simulate what the setup.html JS does when it calls the IPC:
 *   const statuses = await window.pocketAgent.checkPermissions([...])
 *
 * This mirrors the main-process handler:
 *   ipcMain.handle('permissions:checkStatus', (_, types) => getPermissionsStatus(types))
 */
function simulateCheckPermissions(types: PermissionType[]): PermissionStatus[] {
  return getPermissionsStatus(types);
}

/**
 * Simulate the rendering decision for a single permission item.
 * Returns the same shape of data the renderPermissionsList() function
 * uses to decide icon colour, hint text, and action button visibility.
 */
function renderDecision(s: PermissionStatus) {
  return {
    iconClass: s.granted ? 'granted' : 'missing',
    showOpenSettings: !s.granted,
    showRestartHint: !s.granted && s.type === 'full-disk-access',
  };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockGetMediaAccessStatus.mockReturnValue('granted');
    mockIsTrustedAccessibilityClient.mockReturnValue(true);
    mockAccessSync.mockImplementation(() => undefined);
  });

  // ── Platform gating ─────────────────────────────────────────────────────

  describe('platform gating (step-permissions skip logic)', () => {
    it('shows permissions step on macOS', () => {
      mockPlatform.mockReturnValue('darwin');
      expect(isMacOS()).toBe(true);
    });

    it('skips permissions step on Windows', () => {
      mockPlatform.mockReturnValue('win32');
      expect(isMacOS()).toBe(false);
    });

    it('skips permissions step on Linux', () => {
      mockPlatform.mockReturnValue('linux');
      expect(isMacOS()).toBe(false);
    });
  });

  // ── Permission status checks (IPC: permissions:checkStatus) ─────────────

  describe('permissions:checkStatus IPC', () => {
    it('returns status for all three onboarding permissions', () => {
      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      expect(statuses).toHaveLength(3);
      expect(statuses.map(s => s.type)).toEqual([
        'full-disk-access',
        'accessibility',
        'screen-recording',
      ]);
    });

    it('includes label and description for each permission', () => {
      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      for (const s of statuses) {
        expect(s.label).toBeTruthy();
        expect(s.description).toBeTruthy();
        expect(typeof s.label).toBe('string');
        expect(typeof s.description).toBe('string');
      }
    });

    it('includes settingsUrl for each permission', () => {
      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      for (const s of statuses) {
        expect(s.settingsUrl).toContain('x-apple.systempreferences');
      }
    });

    it('reports all granted when permissions are present', () => {
      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      expect(statuses.every(s => s.granted)).toBe(true);
    });

    it('reports full-disk-access missing when protected files inaccessible', () => {
      mockAccessSync.mockImplementation(() => { throw new Error('EPERM'); });

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);
      const fda = statuses.find(s => s.type === 'full-disk-access')!;

      expect(fda.granted).toBe(false);
    });

    it('reports accessibility missing when not trusted', () => {
      mockIsTrustedAccessibilityClient.mockReturnValue(false);

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);
      const acc = statuses.find(s => s.type === 'accessibility')!;

      expect(acc.granted).toBe(false);
    });

    it('reports screen-recording missing when not granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('denied');

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);
      const sr = statuses.find(s => s.type === 'screen-recording')!;

      expect(sr.granted).toBe(false);
    });

    it('can report multiple permissions missing at once', () => {
      mockAccessSync.mockImplementation(() => { throw new Error('EPERM'); });
      mockIsTrustedAccessibilityClient.mockReturnValue(false);
      mockGetMediaAccessStatus.mockReturnValue('denied');

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      expect(statuses.every(s => !s.granted)).toBe(true);
    });
  });

  // ── Rendering decisions ─────────────────────────────────────────────────

  describe('permission list rendering', () => {
    it('shows green check for granted permissions', () => {
      const status = getPermissionStatus('accessibility');
      const decision = renderDecision(status);

      expect(decision.iconClass).toBe('granted');
      expect(decision.showOpenSettings).toBe(false);
      expect(decision.showRestartHint).toBe(false);
    });

    it('shows orange icon and "Open Settings" for missing permissions', () => {
      mockIsTrustedAccessibilityClient.mockReturnValue(false);

      const status = getPermissionStatus('accessibility');
      const decision = renderDecision(status);

      expect(decision.iconClass).toBe('missing');
      expect(decision.showOpenSettings).toBe(true);
    });

    it('shows restart hint only for missing full-disk-access', () => {
      mockAccessSync.mockImplementation(() => { throw new Error('EPERM'); });

      const fda = getPermissionStatus('full-disk-access');
      expect(renderDecision(fda).showRestartHint).toBe(true);

      // Other missing permissions should NOT show restart hint
      mockIsTrustedAccessibilityClient.mockReturnValue(false);
      const acc = getPermissionStatus('accessibility');
      expect(renderDecision(acc).showRestartHint).toBe(false);

      mockGetMediaAccessStatus.mockReturnValue('denied');
      const sr = getPermissionStatus('screen-recording');
      expect(renderDecision(sr).showRestartHint).toBe(false);
    });

    it('does not show restart hint for granted full-disk-access', () => {
      const fda = getPermissionStatus('full-disk-access');
      expect(renderDecision(fda).showRestartHint).toBe(false);
    });

    it('hides "Open Settings" for granted permissions', () => {
      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      for (const s of statuses) {
        expect(renderDecision(s).showOpenSettings).toBe(false);
      }
    });
  });

  // ── Open Settings IPC (permissions:openSettings) ────────────────────────

  describe('permissions:openSettings IPC', () => {
    it('opens Full Disk Access pane', async () => {
      await openPermissionSettings('full-disk-access');

      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      );
    });

    it('opens Accessibility pane', async () => {
      await openPermissionSettings('accessibility');

      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
    });

    it('opens Screen Recording pane', async () => {
      await openPermissionSettings('screen-recording');

      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    });

    it('opens Windows settings on win32', async () => {
      mockPlatform.mockReturnValue('win32');

      await openPermissionSettings('camera');

      expect(mockOpenExternal).toHaveBeenCalledWith('ms-settings:privacy-webcam');
    });

    it('does nothing for unmapped permissions on win32', async () => {
      mockPlatform.mockReturnValue('win32');

      await openPermissionSettings('full-disk-access');

      expect(mockOpenExternal).not.toHaveBeenCalled();
    });
  });

  // ── Onboarding flow decisions ───────────────────────────────────────────

  describe('flow navigation logic', () => {
    it('keychain success → permissions step on macOS', () => {
      // Simulates: initKeychain() success, then checkAndShowPermissions()
      mockPlatform.mockReturnValue('darwin');

      const shouldShowPermissions = isMacOS();

      expect(shouldShowPermissions).toBe(true);
    });

    it('keychain success → auth step on non-macOS', () => {
      mockPlatform.mockReturnValue('win32');

      const shouldShowPermissions = isMacOS();

      // Non-macOS: skip permissions, go straight to auth
      expect(shouldShowPermissions).toBe(false);
    });

    it('skip keychain → same flow as keychain success', () => {
      // skipKeychain() calls checkAndShowPermissions() — same path
      mockPlatform.mockReturnValue('darwin');
      expect(isMacOS()).toBe(true);

      mockPlatform.mockReturnValue('linux');
      expect(isMacOS()).toBe(false);
    });

    it('back from auth returns to permissions when permissions were shown', () => {
      // goBackFromAuth() checks permissionsShown flag
      // If macOS + permissions step was displayed, back goes to permissions
      let permissionsShown = false;

      mockPlatform.mockReturnValue('darwin');
      if (isMacOS()) {
        permissionsShown = true;
      }

      const backTarget = permissionsShown ? 'step-permissions' : 'step-keychain';
      expect(backTarget).toBe('step-permissions');
    });

    it('back from auth returns to keychain when permissions were skipped', () => {
      // Non-macOS: permissions step was never shown
      let permissionsShown = false;

      mockPlatform.mockReturnValue('win32');
      if (isMacOS()) {
        permissionsShown = true;
      }

      const backTarget = permissionsShown ? 'step-permissions' : 'step-keychain';
      expect(backTarget).toBe('step-keychain');
    });
  });

  // ── Only onboarding-relevant permissions are checked ────────────────────

  describe('onboarding permission scope', () => {
    it('only checks full-disk-access, accessibility, screen-recording', () => {
      // These are the only three that matter for onboarding
      // Automation always returns true (prompted per-app), camera/mic not used
      expect(ONBOARDING_PERMISSIONS).toEqual([
        'full-disk-access',
        'accessibility',
        'screen-recording',
      ]);
    });

    it('does NOT include automation (always true, prompted per-app)', () => {
      expect(checkPermission('automation')).toBe(true);
      expect(ONBOARDING_PERMISSIONS).not.toContain('automation');
    });

    it('does NOT include bluetooth (always true)', () => {
      expect(checkPermission('bluetooth')).toBe(true);
      expect(ONBOARDING_PERMISSIONS).not.toContain('bluetooth');
    });

    it('does NOT include camera or microphone (not used by app)', () => {
      expect(ONBOARDING_PERMISSIONS).not.toContain('camera');
      expect(ONBOARDING_PERMISSIONS).not.toContain('microphone');
    });
  });

  // ── Refresh behaviour ───────────────────────────────────────────────────

  describe('refresh permissions', () => {
    it('re-checks live status on each call', () => {
      // First call: all granted
      let statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);
      expect(statuses.every(s => s.granted)).toBe(true);

      // User grants accessibility in System Settings → still granted
      // User revokes screen-recording (simulated by changing mock)
      mockGetMediaAccessStatus.mockReturnValue('denied');
      statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      const sr = statuses.find(s => s.type === 'screen-recording')!;
      expect(sr.granted).toBe(false);

      // Full Disk Access and Accessibility still granted
      const fda = statuses.find(s => s.type === 'full-disk-access')!;
      const acc = statuses.find(s => s.type === 'accessibility')!;
      expect(fda.granted).toBe(true);
      expect(acc.granted).toBe(true);
    });

    it('updates rendering when permission state changes', () => {
      // Initially missing
      mockIsTrustedAccessibilityClient.mockReturnValue(false);
      let status = getPermissionStatus('accessibility');
      expect(renderDecision(status).iconClass).toBe('missing');
      expect(renderDecision(status).showOpenSettings).toBe(true);

      // User grants it
      mockIsTrustedAccessibilityClient.mockReturnValue(true);
      status = getPermissionStatus('accessibility');
      expect(renderDecision(status).iconClass).toBe('granted');
      expect(renderDecision(status).showOpenSettings).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles partial permissions gracefully', () => {
      // Only accessibility missing
      mockIsTrustedAccessibilityClient.mockReturnValue(false);

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);
      const granted = statuses.filter(s => s.granted);
      const missing = statuses.filter(s => !s.granted);

      expect(granted).toHaveLength(2);
      expect(missing).toHaveLength(1);
      expect(missing[0].type).toBe('accessibility');
    });

    it('full-disk-access falls back to Messages if Safari history inaccessible', () => {
      // First accessSync call (Safari) throws, second (Messages) succeeds
      let callCount = 0;
      mockAccessSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('EPERM');
        // Second call succeeds
      });

      expect(checkPermission('full-disk-access')).toBe(true);
    });

    it('full-disk-access returns false only when both probes fail', () => {
      mockAccessSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(checkPermission('full-disk-access')).toBe(false);
    });

    it('non-macOS returns all permissions as granted', () => {
      mockPlatform.mockReturnValue('win32');

      const statuses = simulateCheckPermissions(ONBOARDING_PERMISSIONS);

      // On non-macOS, checkPermission returns true for everything
      expect(statuses.every(s => s.granted)).toBe(true);
    });
  });
});
