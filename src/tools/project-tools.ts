/**
 * Project management tools for the agent
 *
 * - set_project: Set the current session's working directory
 * - get_project: Get the current session's working directory
 * - clear_project: Reset the current session's working directory to default
 *
 * These tools operate per-session via the working_directory column in the DB,
 * rather than changing the global AgentManager workspace.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentManager } from '../agent/index.js';
import { getCurrentSessionId } from './session-context';

// Get database path
function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'), // macOS
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'), // Linux
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'), // Windows
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return possiblePaths[0];
}

/**
 * Get database connection
 */
function getDb(): Database.Database | null {
  try {
    if (!fs.existsSync(getDbPath())) {
      return null;
    }
    const db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize path
 */
function validatePath(inputPath: string): { valid: boolean; normalized?: string; error?: string } {
  // Prevent path traversal
  if (inputPath.includes('..') || inputPath.includes('\0')) {
    return { valid: false, error: 'Invalid path: contains traversal characters' };
  }

  // Must be absolute
  if (!path.isAbsolute(inputPath)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  // Normalize
  const normalized = path.normalize(inputPath);

  // Check exists
  if (!fs.existsSync(normalized)) {
    return { valid: false, error: `Path does not exist: ${normalized}` };
  }

  // Check is directory
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${normalized}` };
  }

  return { valid: true, normalized };
}

/**
 * Set project tool definition
 */
export function getSetProjectToolDefinition() {
  return {
    name: 'set_project',
    description: 'Set the working directory for this session to a project path. Takes effect on next message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['path'],
    },
  };
}

/**
 * Set project tool handler — updates the current session's working_directory
 */
export async function handleSetProjectTool(input: unknown): Promise<string> {
  const { path: inputPath } = input as { path: string };

  if (!inputPath) {
    return JSON.stringify({ error: 'path is required' });
  }

  // Validate path
  const validation = validatePath(inputPath);
  if (!validation.valid) {
    return JSON.stringify({ error: validation.error });
  }

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found. Please start Pocket Agent first.' });
  }

  try {
    const sessionId = getCurrentSessionId();
    console.log(`[ProjectTools] set_project: session=${sessionId} path=${validation.normalized}`);

    // Update the session's working_directory in the DB
    db.prepare(`
      UPDATE sessions SET working_directory = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(validation.normalized, sessionId);

    // Flag the session for restart after the current turn completes.
    // Can't close the session mid-turn (causes "Session closed" errors),
    // so AgentManager will close it after the turn finishes.
    AgentManager.flagProjectSwitch(sessionId);

    return JSON.stringify({
      success: true,
      message: `Project switched to: ${validation.normalized}`,
      path: validation.normalized,
      note: 'Working directory updated. It will take effect on the next message.',
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

/**
 * Get project tool definition
 */
export function getGetProjectToolDefinition() {
  return {
    name: 'get_project',
    description: 'Get the currently active project directory for this session.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  };
}

/**
 * Get project tool handler — returns the current session's working directory
 */
export async function handleGetProjectTool(): Promise<string> {
  const defaultWorkspace = AgentManager.getProjectRoot();

  const db = getDb();
  if (!db) {
    return JSON.stringify({
      success: true,
      hasProject: false,
      message: 'Database not found, using default workspace',
      currentWorkspace: defaultWorkspace,
      defaultWorkspace,
    });
  }

  try {
    const sessionId = getCurrentSessionId();
    const row = db.prepare('SELECT working_directory FROM sessions WHERE id = ?').get(sessionId) as { working_directory: string | null } | undefined;

    const workingDir = row?.working_directory;
    console.log(`[ProjectTools] get_project: session=${sessionId} working_directory=${workingDir || 'null'}`);

    if (!workingDir) {
      return JSON.stringify({
        success: true,
        hasProject: false,
        message: 'No active project set — using default workspace',
        currentWorkspace: defaultWorkspace,
        defaultWorkspace,
      });
    }

    // Verify path still exists
    if (!fs.existsSync(workingDir)) {
      return JSON.stringify({
        success: true,
        hasProject: true,
        path: workingDir,
        warning: 'Project path no longer exists',
        exists: false,
        defaultWorkspace,
      });
    }

    return JSON.stringify({
      success: true,
      hasProject: true,
      path: workingDir,
      exists: true,
      defaultWorkspace,
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

/**
 * Clear project tool definition
 */
export function getClearProjectToolDefinition() {
  return {
    name: 'clear_project',
    description: 'Clear the active project and return to the default workspace for this session.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  };
}

/**
 * Clear project tool handler — resets the current session's working directory to null
 */
export async function handleClearProjectTool(): Promise<string> {
  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  try {
    const sessionId = getCurrentSessionId();
    const defaultPath = AgentManager.getProjectRoot();
    console.log(`[ProjectTools] clear_project: session=${sessionId} resetting to default=${defaultPath}`);

    const result = db.prepare(`
      UPDATE sessions SET working_directory = NULL, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(sessionId);

    // Flag the session for restart after the current turn completes.
    AgentManager.flagProjectSwitch(sessionId);

    if (result.changes > 0) {
      return JSON.stringify({
        success: true,
        message: `Active project cleared. Workspace will reset to: ${defaultPath} on next message.`,
        path: defaultPath,
      });
    } else {
      return JSON.stringify({
        success: true,
        message: `No session found. Current workspace: ${defaultPath}`,
        path: defaultPath,
      });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

/**
 * Get all project tools
 */
export function getProjectTools() {
  return [
    {
      ...getSetProjectToolDefinition(),
      handler: handleSetProjectTool,
    },
    {
      ...getGetProjectToolDefinition(),
      handler: handleGetProjectTool,
    },
    {
      ...getClearProjectToolDefinition(),
      handler: handleClearProjectTool,
    },
  ];
}
