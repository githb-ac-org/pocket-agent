/**
 * Scheduler tools for the agent
 *
 * Allows the agent to create, list, and manage scheduled tasks/reminders
 * Supports three schedule types:
 * - cron: Standard cron expressions (e.g., "0 9 * * *")
 * - at: One-time execution (e.g., "tomorrow 3pm", "in 10 minutes")
 * - every: Recurring intervals (requires "every" prefix, e.g., "every 30m", "every 2h")
 * - Bare durations like "30m", "2h" are treated as one-shot (same as "in 30 minutes")
 */

import { getScheduler } from '../scheduler';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getCurrentSessionId } from './session-context';

function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

// Parse schedule string and determine type
function parseSchedule(input: string): {
  type: 'cron' | 'at' | 'every';
  schedule?: string;
  runAt?: string;
  intervalMs?: number;
} | null {
  const trimmed = input.trim();

  // Check for explicit "every" pattern (recurring): "every 30m", "every 2h", "every 1d"
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (everyMatch) {
    const [, amount, unit] = everyMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.startsWith('m')) ms = num * 60 * 1000;
    else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
    else ms = num * 24 * 60 * 60 * 1000;
    return { type: 'every', intervalMs: ms };
  }

  // Check for bare duration (one-shot): "30m", "2h", "1d" → treated as "in X"
  const bareMatch = trimmed.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (bareMatch) {
    const [, amount, unit] = bareMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.startsWith('m')) ms = num * 60 * 1000;
    else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
    else ms = num * 24 * 60 * 60 * 1000;
    const runAt = new Date(Date.now() + ms).toISOString();
    return { type: 'at', runAt };
  }

  // Check for "at" pattern: specific datetime
  const atTime = parseDateTime(trimmed);
  if (atTime) {
    // If it's a relative/specific time, treat as "at"
    if (trimmed.match(/^(today|tomorrow|in\s+\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)) {
      return { type: 'at', runAt: atTime };
    }
  }

  // Check for cron expression (5 parts)
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5 && validateCron(trimmed)) {
    return { type: 'cron', schedule: trimmed };
  }

  // Try parsing as datetime for "at" type
  if (atTime) {
    return { type: 'at', runAt: atTime };
  }

  return null;
}

// Parse datetime string to ISO format
function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today 3pm", "tomorrow 9am", "monday 2pm"
  const relativeMatch = input.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (relativeMatch) {
    const [, dayStr, hourStr, minStr, ampm] = relativeMatch;
    const targetDate = new Date(now);

    if (dayStr.toLowerCase() === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (dayStr.toLowerCase() !== 'today') {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(dayStr.toLowerCase());
      const currentDay = targetDate.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      targetDate.setDate(targetDate.getDate() + daysToAdd);
    }

    let hour = parseInt(hourStr, 10);
    const min = minStr ? parseInt(minStr, 10) : 0;
    if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;

    targetDate.setHours(hour, min, 0, 0);
    return targetDate.toISOString();
  }

  // "in 2 hours", "in 30 minutes", "in 3 days"
  const inMatch = input.match(/^in\s+(\d+)\s*(hour|hr|minute|min|day|d)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.toLowerCase().startsWith('hour') || unit.toLowerCase() === 'hr') {
      ms = num * 3600000;
    } else if (unit.toLowerCase().startsWith('min')) {
      ms = num * 60000;
    } else {
      ms = num * 86400000;
    }
    return new Date(now.getTime() + ms).toISOString();
  }

  // Try direct parse (ISO format, etc.)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime()) && parsed > now) {
    return parsed.toISOString();
  }

  return null;
}

// Validate cron expression
function validateCron(schedule: string): boolean {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day
    [1, 12],  // month
    [0, 7],   // weekday
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === '*') continue;
    if (part.includes('/')) continue;
    if (part.includes('-')) continue;
    if (part.includes(',')) continue;

    const num = parseInt(part, 10);
    if (isNaN(num) || num < ranges[i][0] || num > ranges[i][1]) {
      return false;
    }
  }

  return true;
}

// Calculate next run time
function calculateNextRun(type: string, schedule: string | null, runAt: string | null, intervalMs: number | null): string | null {
  const now = new Date();

  if (type === 'at' && runAt) {
    const runDate = new Date(runAt);
    return runDate > now ? runAt : null;
  }

  if (type === 'every' && intervalMs) {
    return new Date(now.getTime() + intervalMs).toISOString();
  }

  if (type === 'cron' && schedule) {
    const parts = schedule.split(/\s+/);
    const [min, hour] = parts;
    const next = new Date(now);
    next.setSeconds(0, 0);

    if (min !== '*') next.setMinutes(parseInt(min, 10));
    if (hour !== '*') next.setHours(parseInt(hour, 10));

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

/**
 * Create routine tool definition
 * Routines send a prompt to the LLM at the scheduled time - the LLM then executes it
 */
export function getCreateRoutineToolDefinition() {
  return {
    name: 'create_routine',
    description: 'Schedule a prompt for the LLM to execute at a specific time. When triggered, the prompt is sent to the agent who will perform the requested action (browse web, check APIs, research, etc). For simple notifications with no LLM action, use create_reminder instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for this routine (e.g., "morning_weather")',
        },
        schedule: {
          type: 'string',
          description: 'When to run. One-shot: "30m", "2h", "in 10 minutes", "tomorrow 3pm". Recurring: "every 30m", "every 2h", or cron "0 9 * * *". Bare durations like "2h" are ONE-SHOT (runs once). Use "every 2h" for recurring.',
        },
        prompt: {
          type: 'string',
          description: 'The prompt sent to the LLM when triggered. Write as an instruction: "Check the weather in KL and tell me", "Summarize today\'s tech news", "Research competitors for X".',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  };
}

/**
 * Create routine tool handler
 * Supports natural language scheduling in addition to cron
 */
export async function handleCreateRoutineTool(input: unknown): Promise<string> {
  const { name, schedule, prompt } = input as {
    name: string;
    schedule: string;
    prompt: string;
  };

  if (!name || !schedule || !prompt) {
    return JSON.stringify({ error: 'Missing required fields: name, schedule, prompt' });
  }

  console.log(`[Scheduler] Creating routine: ${name} (${schedule})`);

  // Parse the schedule string
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return JSON.stringify({
      error: `Could not parse schedule: "${schedule}"`,
      hint: 'One-shot: "30m", "2h", "in 10 minutes", "tomorrow 3pm". Recurring: "every 2h", or cron "0 9 * * *"',
    });
  }

  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Ensure table has the new columns
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT DEFAULT 'cron'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN interval_ms INTEGER`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN session_id TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN job_type TEXT DEFAULT 'routine'`);
    } catch { /* column exists */ }

    const sessionId = getCurrentSessionId();

    // Auto-enable delete-after for one-time "at" jobs
    const deleteAfterRun = parsed.type === 'at' ? 1 : 0;

    // Channel is always 'desktop' - routing broadcasts to all configured channels
    const targetChannel = 'desktop';

    const nextRunAt = calculateNextRun(
      parsed.type,
      parsed.schedule || null,
      parsed.runAt || null,
      parsed.intervalMs || null
    );

    // Check if exists - update or insert
    const existing = db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);

    if (existing) {
      db.prepare(`
        UPDATE cron_jobs SET
          schedule_type = ?, schedule = ?, run_at = ?, interval_ms = ?,
          prompt = ?, channel = ?, enabled = 1,
          delete_after_run = ?, next_run_at = ?, session_id = ?, job_type = ?,
          updated_at = datetime('now')
        WHERE name = ?
      `).run(
        parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'routine', name
      );
    } else {
      db.prepare(`
        INSERT INTO cron_jobs (
          name, schedule_type, schedule, run_at, interval_ms,
          prompt, channel, enabled, delete_after_run, next_run_at, session_id, job_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        name, parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'routine'
      );
    }

    db.close();

    // Build user-friendly schedule description
    let scheduleDesc: string;
    if (parsed.type === 'at') {
      scheduleDesc = `one-time at ${formatDateTime(parsed.runAt!)}`;
    } else if (parsed.type === 'every') {
      scheduleDesc = `every ${formatDuration(parsed.intervalMs!)}`;
    } else {
      scheduleDesc = `cron: ${parsed.schedule}`;
    }

    console.log(`[Scheduler] Routine created: ${name} (${parsed.type})`);
    return JSON.stringify({
      success: true,
      message: `Routine "${name}" created`,
      name,
      type: parsed.type,
      schedule: scheduleDesc,
      next_run: formatDateTime(nextRunAt),
      one_time: deleteAfterRun === 1,
      channel: targetChannel,
      session_id: sessionId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Scheduler] Failed to create routine: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * Create reminder tool definition
 * Reminders are simple notifications - no LLM processing, just display the message
 */
export function getCreateReminderToolDefinition() {
  return {
    name: 'create_reminder',
    description: 'Create a simple reminder notification (NO LLM processing). The message is displayed exactly as written. Use for: "remind me to X", "don\'t forget Y". For tasks requiring LLM action (research, checking weather), use create_routine instead. NOT for todo items - use task_add for todos.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the reminder (e.g., "shower_reminder")',
        },
        schedule: {
          type: 'string',
          description: 'When to remind. One-shot: "30m", "2h", "in 10 minutes", "tomorrow 3pm". Recurring: "every 30m", "every 2h", or cron "0 9 * * *". Bare durations like "2h" are ONE-SHOT (runs once). Use "every 2h" for recurring.',
        },
        reminder: {
          type: 'string',
          description: 'The exact message to display. Examples: "Hey Ken! Time to take a shower 🚿", "Don\'t forget to call mom! 📱". Write a friendly, complete message.',
        },
      },
      required: ['name', 'schedule', 'reminder'],
    },
  };
}

/**
 * Create reminder tool handler
 */
export async function handleCreateReminderTool(input: unknown): Promise<string> {
  const { name, schedule, reminder } = input as {
    name: string;
    schedule: string;
    reminder: string;
  };

  if (!name || !schedule || !reminder) {
    return JSON.stringify({ error: 'Missing required fields: name, schedule, reminder' });
  }

  console.log(`[Scheduler] Creating reminder: ${name} (${schedule})`);

  // Parse the schedule string
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return JSON.stringify({
      error: `Could not parse schedule: "${schedule}"`,
      hint: 'One-shot: "30m", "2h", "in 10 minutes", "tomorrow 3pm". Recurring: "every 2h", or cron "0 9 * * *"',
    });
  }

  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Ensure table has the new columns (including job_type)
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT DEFAULT 'cron'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN interval_ms INTEGER`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN session_id TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN job_type TEXT DEFAULT 'routine'`);
    } catch { /* column exists */ }

    const sessionId = getCurrentSessionId();

    // Auto-enable delete-after for one-time "at" jobs
    const deleteAfterRun = parsed.type === 'at' ? 1 : 0;

    // Channel is always 'desktop' - routing broadcasts to all configured channels
    const targetChannel = 'desktop';

    const nextRunAt = calculateNextRun(
      parsed.type,
      parsed.schedule || null,
      parsed.runAt || null,
      parsed.intervalMs || null
    );

    // Check if exists - update or insert
    const existing = db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);

    if (existing) {
      db.prepare(`
        UPDATE cron_jobs SET
          schedule_type = ?, schedule = ?, run_at = ?, interval_ms = ?,
          prompt = ?, channel = ?, enabled = 1,
          delete_after_run = ?, next_run_at = ?, session_id = ?, job_type = ?,
          updated_at = datetime('now')
        WHERE name = ?
      `).run(
        parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        reminder, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'reminder', name
      );
    } else {
      db.prepare(`
        INSERT INTO cron_jobs (
          name, schedule_type, schedule, run_at, interval_ms,
          prompt, channel, enabled, delete_after_run, next_run_at, session_id, job_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        name, parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        reminder, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'reminder'
      );
    }

    db.close();

    // Build user-friendly schedule description
    let scheduleDesc: string;
    if (parsed.type === 'at') {
      scheduleDesc = `one-time at ${formatDateTime(parsed.runAt!)}`;
    } else if (parsed.type === 'every') {
      scheduleDesc = `every ${formatDuration(parsed.intervalMs!)}`;
    } else {
      scheduleDesc = `cron: ${parsed.schedule}`;
    }

    console.log(`[Scheduler] Reminder created: ${name} (${parsed.type})`);
    return JSON.stringify({
      success: true,
      message: `Reminder "${name}" created`,
      name,
      type: 'reminder',
      schedule: scheduleDesc,
      next_run: formatDateTime(nextRunAt),
      one_time: deleteAfterRun === 1,
      channel: targetChannel,
      session_id: sessionId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Scheduler] Failed to create reminder: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * List routines tool definition
 */
export function getListRoutinesToolDefinition() {
  return {
    name: 'list_routines',
    description: 'List all scheduled routines (LLM tasks) and reminders (simple notifications). Shows name, type, schedule, and next run time. NOT for todo items - use task_list for todos.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * Format schedule for display based on schedule_type
 */
function formatScheduleDisplay(job: {
  schedule_type?: string;
  schedule: string | null;
  run_at?: string | null;
  interval_ms?: number | null;
}): string {
  const scheduleType = job.schedule_type || 'cron';

  if (scheduleType === 'cron' && job.schedule) {
    return `cron: ${job.schedule}`;
  }
  if (scheduleType === 'at' && job.run_at) {
    const formatted = formatDateTime(job.run_at);
    return `at: ${formatted || job.run_at}`;
  }
  if (scheduleType === 'every' && job.interval_ms) {
    return `every ${formatDuration(job.interval_ms)}`;
  }

  // Fallback: try to show whatever is available
  if (job.schedule) return job.schedule;
  if (job.run_at) return `at: ${formatDateTime(job.run_at) || job.run_at}`;
  if (job.interval_ms) return `every ${formatDuration(job.interval_ms)}`;

  return 'unknown';
}

/**
 * List routines handler
 */
export async function handleListRoutinesTool(): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const jobs = scheduler.getAllJobs();

  if (jobs.length === 0) {
    return JSON.stringify({
      success: true,
      message: 'No scheduled tasks',
      tasks: [],
    });
  }

  return JSON.stringify({
    success: true,
    count: jobs.length,
    tasks: jobs.map(job => ({
      name: job.name,
      type: job.job_type || 'routine',
      schedule: formatScheduleDisplay(job),
      next_run: job.next_run_at ? formatDateTime(job.next_run_at) : null,
      prompt: job.prompt,
      channel: job.channel,
      enabled: job.enabled,
    })),
  });
}

/**
 * Delete routine tool definition
 */
export function getDeleteRoutineToolDefinition() {
  return {
    name: 'delete_routine',
    description: 'Delete a scheduled routine or reminder by name. NOT for todo items - use task_delete for todos.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the routine to delete',
        },
      },
      required: ['name'],
    },
  };
}

/**
 * Delete routine handler
 */
export async function handleDeleteRoutineTool(input: unknown): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const { name } = input as { name: string };

  if (!name) {
    return JSON.stringify({ error: 'Routine name is required' });
  }

  const success = scheduler.deleteJob(name);

  if (success) {
    console.log(`[Scheduler] Deleted routine: ${name}`);
    return JSON.stringify({
      success: true,
      message: `Routine "${name}" deleted`,
    });
  } else {
    return JSON.stringify({
      success: false,
      error: `Routine "${name}" not found`,
    });
  }
}

/**
 * Get all scheduler tools
 */
export function getSchedulerTools() {
  return [
    {
      ...getCreateRoutineToolDefinition(),
      handler: handleCreateRoutineTool,
    },
    {
      ...getCreateReminderToolDefinition(),
      handler: handleCreateReminderTool,
    },
    {
      ...getListRoutinesToolDefinition(),
      handler: handleListRoutinesTool,
    },
    {
      ...getDeleteRoutineToolDefinition(),
      handler: handleDeleteRoutineTool,
    },
  ];
}
