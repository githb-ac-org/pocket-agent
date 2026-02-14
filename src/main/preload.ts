import { contextBridge, ipcRenderer } from 'electron';

// Expose API to renderer process
contextBridge.exposeInMainWorld('pocketAgent', {
  // Chat
  send: (message: string, sessionId?: string) => ipcRenderer.invoke('agent:send', message, sessionId),
  stop: (sessionId?: string) => ipcRenderer.invoke('agent:stop', sessionId),
  onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { type: string; toolName?: string; toolInput?: string; message?: string }) => callback(status);
    ipcRenderer.on('agent:status', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  saveAttachment: (name: string, dataUrl: string) => ipcRenderer.invoke('attachment:save', name, dataUrl),
  extractText: (filePath: string) => ipcRenderer.invoke('attachment:extract-text', filePath),
  readMedia: (filePath: string) => ipcRenderer.invoke('agent:readMedia', filePath),
  onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string; sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { jobName: string; prompt: string; response: string; sessionId: string }) => callback(data);
    ipcRenderer.on('scheduler:message', listener);
    return () => ipcRenderer.removeListener('scheduler:message', listener);
  },
  onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio'; wasCompacted?: boolean; media?: Array<{ type: string; filePath: string; mimeType: string }> }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio'; wasCompacted?: boolean; media?: Array<{ type: string; filePath: string; mimeType: string }> }) => callback(data);
    ipcRenderer.on('telegram:message', listener);
    return () => ipcRenderer.removeListener('telegram:message', listener);
  },
  onSessionsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('sessions:changed', listener);
    return () => ipcRenderer.removeListener('sessions:changed', listener);
  },
  onModelChanged: (callback: (model: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, model: string) => callback(model);
    ipcRenderer.on('model:changed', listener);
    return () => ipcRenderer.removeListener('model:changed', listener);
  },
  getHistory: (limit?: number, sessionId?: string) => ipcRenderer.invoke('agent:history', limit, sessionId),
  getStats: (sessionId?: string) => ipcRenderer.invoke('agent:stats', sessionId),
  clearConversation: (sessionId?: string) => ipcRenderer.invoke('agent:clear', sessionId),

  // Sessions
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (name: string) => ipcRenderer.invoke('sessions:create', name),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),

  // Facts
  listFacts: () => ipcRenderer.invoke('facts:list'),
  searchFacts: (query: string) => ipcRenderer.invoke('facts:search', query),
  getFactCategories: () => ipcRenderer.invoke('facts:categories'),
  deleteFact: (id: number) => ipcRenderer.invoke('facts:delete', id),
  getGraphData: () => ipcRenderer.invoke('facts:graph-data'),

  // Soul (Self-Knowledge)
  listSoulAspects: () => ipcRenderer.invoke('soul:list'),
  getSoulAspect: (aspect: string) => ipcRenderer.invoke('soul:get', aspect),
  deleteSoulAspect: (id: number) => ipcRenderer.invoke('soul:delete', id),

  // Daily Logs
  listDailyLogs: () => ipcRenderer.invoke('dailyLogs:list'),

  // App windows
  openFactsGraph: () => ipcRenderer.invoke('app:openFactsGraph'),
  openFacts: () => ipcRenderer.invoke('app:openFacts'),
  openDailyLogs: () => ipcRenderer.invoke('app:openDailyLogs'),
  openSoul: () => ipcRenderer.invoke('app:openSoul'),
  openCustomize: () => ipcRenderer.invoke('app:openCustomize'),
  openRoutines: () => ipcRenderer.invoke('app:openRoutines'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  openPath: (filePath: string) => ipcRenderer.invoke('app:openPath', filePath),
  openImage: (src: string) => ipcRenderer.invoke('app:openImage', src),

  // Customize
  getIdentity: () => ipcRenderer.invoke('customize:getIdentity'),
  saveIdentity: (content: string) => ipcRenderer.invoke('customize:saveIdentity', content),
  getIdentityPath: () => ipcRenderer.invoke('customize:getIdentityPath'),
  getInstructions: () => ipcRenderer.invoke('customize:getInstructions'),
  saveInstructions: (content: string) => ipcRenderer.invoke('customize:saveInstructions', content),
  getInstructionsPath: () => ipcRenderer.invoke('customize:getInstructionsPath'),

  // Location and timezone
  lookupLocation: (query: string) => ipcRenderer.invoke('location:lookup', query),
  getTimezones: () => ipcRenderer.invoke('timezone:list'),

  // Cron
  getCronJobs: () => ipcRenderer.invoke('cron:list'),
  createCronJob: (name: string, schedule: string, prompt: string, channel: string, sessionId: string) =>
    ipcRenderer.invoke('cron:create', name, schedule, prompt, channel, sessionId),
  deleteCronJob: (name: string) => ipcRenderer.invoke('cron:delete', name),
  toggleCronJob: (name: string, enabled: boolean) => ipcRenderer.invoke('cron:toggle', name, enabled),
  runCronJob: (name: string) => ipcRenderer.invoke('cron:run', name),
  getCronHistory: (limit?: number) => ipcRenderer.invoke('cron:history', limit),

  // App info
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string) => ipcRenderer.invoke('settings:delete', key),
  getSettingsSchema: (category?: string) => ipcRenderer.invoke('settings:schema', category),
  isFirstRun: () => ipcRenderer.invoke('settings:isFirstRun'),
  initializeKeychain: () => ipcRenderer.invoke('settings:initializeKeychain'),
  validateAnthropicKey: (key: string) => ipcRenderer.invoke('settings:validateAnthropic', key),
  validateOpenAIKey: (key: string) => ipcRenderer.invoke('settings:validateOpenAI', key),
  validateMoonshotKey: (key: string) => ipcRenderer.invoke('settings:validateMoonshot', key),
  validateGlmKey: (key: string) => ipcRenderer.invoke('settings:validateGlm', key),
  validateTelegramToken: (token: string) => ipcRenderer.invoke('settings:validateTelegram', token),
  getAvailableModels: () => ipcRenderer.invoke('settings:getAvailableModels'),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  openSettings: (tab?: string) => ipcRenderer.invoke('app:openSettings', tab),
  openChat: () => ipcRenderer.invoke('app:openChat'),
  startOAuth: () => ipcRenderer.invoke('auth:startOAuth'),
  completeOAuth: (code: string) => ipcRenderer.invoke('auth:completeOAuth', code),
  cancelOAuth: () => ipcRenderer.invoke('auth:cancelOAuth'),
  isOAuthPending: () => ipcRenderer.invoke('auth:isOAuthPending'),
  validateOAuth: () => ipcRenderer.invoke('auth:validateOAuth'),

  // Commands (Workflows)
  getCommands: () => ipcRenderer.invoke('commands:list'),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
  onUpdateStatus: (callback: (status: { status: string; info?: unknown; progress?: { percent: number }; error?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { status: string; info?: unknown; progress?: { percent: number }; error?: string }) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },

  // Browser control
  detectInstalledBrowsers: () => ipcRenderer.invoke('browser:detectInstalled'),
  launchBrowser: (browserId: string, port?: number) => ipcRenderer.invoke('browser:launch', browserId, port),
  testBrowserConnection: (cdpUrl?: string) => ipcRenderer.invoke('browser:testConnection', cdpUrl),

  // Shell commands
  runCommand: (command: string) => ipcRenderer.invoke('shell:runCommand', command),

  // Platform info
  getPlatform: () => process.platform,

  // Navigation
  onNavigateTab: (callback: (tab: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: string) => callback(tab);
    ipcRenderer.on('navigate-tab', listener);
    return () => ipcRenderer.removeListener('navigate-tab', listener);
  },
});

// Session type
interface Session {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  telegram_linked?: boolean;
  telegram_group_name?: string | null;
}

// Type declarations for renderer
declare global {
  interface Window {
    pocketAgent: {
      send: (message: string, sessionId?: string) => Promise<{ success: boolean; response?: string; error?: string; tokensUsed?: number; suggestedPrompt?: string; media?: Array<{ type: string; filePath: string; mimeType: string }> }>;
      stop: (sessionId?: string) => Promise<{ success: boolean }>;
      onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => () => void;
      saveAttachment: (name: string, dataUrl: string) => Promise<string>;
      extractText: (filePath: string) => Promise<string>;
      readMedia: (filePath: string) => Promise<string | null>;
      onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string; sessionId: string }) => void) => () => void;
      onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio'; wasCompacted?: boolean; media?: Array<{ type: string; filePath: string; mimeType: string }> }) => void) => () => void;
      onSessionsChanged: (callback: () => void) => () => void;
      onModelChanged: (callback: (model: string) => void) => () => void;
      getHistory: (limit?: number, sessionId?: string) => Promise<Array<{ role: string; content: string; timestamp: string; metadata?: { source?: string; jobName?: string } }>>;
      getStats: (sessionId?: string) => Promise<{ messageCount: number; factCount: number; estimatedTokens: number; sessionCount?: number; contextTokens?: number; contextWindow?: number } | null>;
      clearConversation: (sessionId?: string) => Promise<{ success: boolean }>;
      // Sessions
      getSessions: () => Promise<Session[]>;
      createSession: (name: string) => Promise<{ success: boolean; session?: Session; error?: string }>;
      renameSession: (id: string, name: string) => Promise<{ success: boolean; error?: string }>;
      deleteSession: (id: string) => Promise<{ success: boolean }>;
      listFacts: () => Promise<Array<{ id: number; category: string; subject: string; content: string }>>;
      searchFacts: (query: string) => Promise<Array<{ category: string; subject: string; content: string }>>;
      getFactCategories: () => Promise<string[]>;
      deleteFact: (id: number) => Promise<{ success: boolean }>;
      getGraphData: () => Promise<{
        nodes: Array<{ id: number; subject: string; category: string; content: string; group: number }>;
        links: Array<{ source: number; target: number; type: 'category' | 'semantic' | 'keyword'; strength: number }>;
      }>;
      // Soul
      listSoulAspects: () => Promise<Array<{ id: number; aspect: string; content: string; created_at: string; updated_at: string }>>;
      getSoulAspect: (aspect: string) => Promise<{ id: number; aspect: string; content: string; created_at: string; updated_at: string } | null>;
      deleteSoulAspect: (id: number) => Promise<{ success: boolean }>;
      // Daily Logs
      listDailyLogs: () => Promise<Array<{ id: number; date: string; content: string; updated_at: string }>>;
      // App windows
      openFactsGraph: () => Promise<void>;
      openFacts: () => Promise<void>;
      openDailyLogs: () => Promise<void>;
      openSoul: () => Promise<void>;
      openCustomize: () => Promise<void>;
      openRoutines: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openPath: (filePath: string) => Promise<void>;
      openImage: (src: string) => Promise<void>;
      // Customize
      getIdentity: () => Promise<string>;
      saveIdentity: (content: string) => Promise<{ success: boolean }>;
      getIdentityPath: () => Promise<string>;
      getInstructions: () => Promise<string>;
      saveInstructions: (content: string) => Promise<{ success: boolean }>;
      getInstructionsPath: () => Promise<string>;
      // Location and timezone
      lookupLocation: (query: string) => Promise<Array<{ city: string; country: string; province: string; timezone: string; display: string }>>;
      getTimezones: () => Promise<string[]>;
      getCronJobs: () => Promise<Array<{ id: number; name: string; schedule_type?: string; schedule: string | null; run_at?: string | null; interval_ms?: number | null; prompt: string; channel: string; enabled: boolean; session_id?: string | null; job_type?: 'routine' | 'reminder' }>>;
      createCronJob: (name: string, schedule: string, prompt: string, channel: string, sessionId: string) => Promise<{ success: boolean }>;
      deleteCronJob: (name: string) => Promise<{ success: boolean }>;
      toggleCronJob: (name: string, enabled: boolean) => Promise<{ success: boolean }>;
      runCronJob: (name: string) => Promise<{ jobName: string; response: string; success: boolean; error?: string } | null>;
      getCronHistory: (limit?: number) => Promise<Array<{ jobName: string; response: string; success: boolean; timestamp: string }>>;
      // App info
      getAppVersion: () => Promise<string>;
      // Settings
      getSettings: () => Promise<Record<string, string>>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<{ success: boolean }>;
      deleteSetting: (key: string) => Promise<{ success: boolean }>;
      getSettingsSchema: (category?: string) => Promise<Array<{ key: string; defaultValue: string; encrypted: boolean; category: string; label: string; description?: string; type: string }>>;
      isFirstRun: () => Promise<boolean>;
      initializeKeychain: () => Promise<{ available: boolean; error?: string }>;
      validateAnthropicKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateOpenAIKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateMoonshotKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateGlmKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: unknown }>;
      getAvailableModels: () => Promise<Array<{ id: string; name: string; provider: string }>>;
      restartAgent: () => Promise<{ success: boolean }>;
      openSettings: (tab?: string) => Promise<void>;
      openChat: () => Promise<void>;
      startOAuth: () => Promise<{ success: boolean; error?: string }>;
      completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
      cancelOAuth: () => Promise<{ success: boolean }>;
      isOAuthPending: () => Promise<boolean>;
      // Commands (Workflows)
      getCommands: () => Promise<Array<{ name: string; description: string; filename: string; content: string }>>;
      // Updates
      checkForUpdates: () => Promise<{ status: string; info?: { version: string }; error?: string }>;
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
      installUpdate: () => Promise<{ success: boolean; error?: string }>;
      getUpdateStatus: () => Promise<{ status: string; info?: { version: string }; progress?: { percent: number }; error?: string }>;
      onUpdateStatus: (callback: (status: { status: string; info?: { version: string }; progress?: { percent: number }; error?: string }) => void) => () => void;
      // Browser control
      detectInstalledBrowsers: () => Promise<Array<{ id: string; name: string; path: string; processName: string; installed: boolean }>>;
      launchBrowser: (browserId: string, port?: number) => Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }>;
      testBrowserConnection: (cdpUrl?: string) => Promise<{ connected: boolean; error?: string; browserInfo?: unknown }>;
      // Shell commands
      runCommand: (command: string) => Promise<string>;
      // Platform info
      getPlatform: () => string;
    };
  }
}
