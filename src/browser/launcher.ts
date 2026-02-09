/**
 * Browser launcher utility
 *
 * Detects installed Chromium browsers and launches them with CDP enabled
 */

import { spawn, exec } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BrowserInfo {
  id: string;
  name: string;
  path: string;
  processName: string;
  bundleId: string;
  installed: boolean;
}

// macOS browser paths and bundle IDs (for App Nap disabling)
const BROWSERS: (Omit<BrowserInfo, 'installed'> & { bundleId: string })[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    processName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    processName: 'Microsoft Edge',
    bundleId: 'com.microsoft.edgemac',
  },
  {
    id: 'brave',
    name: 'Brave',
    path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    processName: 'Brave Browser',
    bundleId: 'com.brave.Browser',
  },
  {
    id: 'arc',
    name: 'Arc',
    path: '/Applications/Arc.app/Contents/MacOS/Arc',
    processName: 'Arc',
    bundleId: 'company.thebrowser.Browser',
  },
  {
    id: 'chromium',
    name: 'Chromium',
    path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    processName: 'Chromium',
    bundleId: 'org.chromium.Chromium',
  },
];

/**
 * Detect installed browsers
 */
export function detectInstalledBrowsers(): BrowserInfo[] {
  return BROWSERS.map((browser) => ({
    ...browser,
    installed: existsSync(browser.path),
  })).filter((b) => b.installed);
}

/**
 * Check if a browser is currently running
 */
export async function isBrowserRunning(browser: BrowserInfo): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`pgrep -x "${browser.processName}"`);
    return stdout.trim().length > 0;
  } catch {
    // pgrep returns exit code 1 if no process found
    return false;
  }
}

/**
 * Test CDP connection
 */
export async function testCdpConnection(
  cdpUrl: string = 'http://localhost:9222'
): Promise<{ connected: boolean; error?: string; browserInfo?: unknown }> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return { connected: false, error: 'CDP endpoint not responding' };
    }

    const info = await response.json();
    return { connected: true, browserInfo: info };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Launch browser with CDP enabled
 */
export async function launchBrowser(
  browserId: string,
  port: number = 9222
): Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }> {
  const browser = BROWSERS.find((b) => b.id === browserId);

  if (!browser) {
    return { success: false, error: `Unknown browser: ${browserId}` };
  }

  if (!existsSync(browser.path)) {
    return { success: false, error: `${browser.name} is not installed` };
  }

  // Check if already running
  const running = await isBrowserRunning(browser as BrowserInfo);
  if (running) {
    return {
      success: false,
      alreadyRunning: true,
      error: `${browser.name} is already running. Please close it first to enable remote debugging.`,
    };
  }

  try {
    // Disable macOS App Nap for this browser before launch.
    // App Nap throttles invisible apps' timers and CPU, which kills
    // CDP responsiveness when the screen is locked.
    if (process.platform === 'darwin') {
      try {
        await execAsync(
          `defaults write ${browser.bundleId} NSAppSleepDisabled -bool YES`
        );
        console.log(`[Browser] Disabled App Nap for ${browser.name}`);
      } catch {
        console.warn(`[Browser] Could not disable App Nap for ${browser.name}`);
      }
    }

    // Launch browser with remote debugging and anti-throttling flags.
    // Without these, Chrome aggressively throttles background tabs
    // (1 timer/sec after 10s, 1 timer/min after 5min) which makes
    // CDP commands unreliable for long-running automation.
    const child = spawn(
      browser.path,
      [
        `--remote-debugging-port=${port}`,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--disable-features=IntensiveWakeUpThrottling',
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    );

    // Don't wait for the process
    child.unref();

    // Wait for CDP to become available with retries
    // Browsers can take a few seconds to fully start
    const maxAttempts = 10;
    const delayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      const result = await testCdpConnection(`http://localhost:${port}`);
      if (result.connected) {
        return { success: true };
      }

      // Log progress for debugging
      console.log(`[Browser] CDP connection attempt ${attempt}/${maxAttempts}...`);
    }

    // All attempts failed
    return {
      success: false,
      error: 'Browser launched but CDP connection timed out. Try "Test Connection" in a moment.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to launch browser',
    };
  }
}
