/**
 * WebSocket protocol types for iOS channel communication.
 */

// === Messages from iOS → Desktop ===

export interface ClientMessage {
  type: 'message' | 'pair' | 'ping' | 'stop' | 'push_token' | 'sessions:list' | 'sessions:switch' | 'sessions:history' | 'sessions:clear' | 'workflows:list' | 'models:list' | 'models:switch'
    | 'facts:list' | 'facts:delete' | 'daily-logs:list' | 'soul:list' | 'soul:delete'
    | 'facts:graph' | 'customize:get' | 'customize:save'
    | 'routines:list' | 'routines:create' | 'routines:delete' | 'routines:toggle' | 'routines:run'
    | 'app:info'
    | 'skin:set'
    | 'mode:get'
    | 'mode:switch';
  id?: string;
}

export interface ClientChatMessage extends ClientMessage {
  type: 'message';
  text: string;
  sessionId: string;
  images?: Array<{
    data: string;
    mediaType: string;
  }>;
  audio?: {
    data: string; // base64 encoded audio
    format: string; // 'm4a', 'ogg', etc.
    duration: number; // seconds
  };
}

export interface ClientPairMessage extends ClientMessage {
  type: 'pair';
  pairingCode: string;
  deviceName: string;
}

export interface ClientPushTokenMessage extends ClientMessage {
  type: 'push_token';
  pushToken: string;
}

// === Messages from Desktop → iOS ===

export interface ServerStatusMessage {
  type: 'status';
  status: string;
  sessionId: string;
  message?: string;
  toolName?: string;
  toolInput?: string;
  partialText?: string;
  agentCount?: number;
  teammateName?: string;
  taskSubject?: string;
  queuePosition?: number;
  queuedMessage?: string;
  blockedReason?: string;
  isPocketCli?: boolean;
  backgroundTaskId?: string;
  backgroundTaskDescription?: string;
  backgroundTaskCount?: number;
}

export interface ServerResponseMessage {
  type: 'response';
  text: string;
  sessionId: string;
  tokensUsed?: number;
  media?: Array<{ type: string; filePath: string; mimeType: string }>;
  timestamp: string;
}

export interface ServerPairResultMessage {
  type: 'pair_result';
  success: boolean;
  error?: string;
  authToken?: string;
  deviceId?: string;
}

export interface ServerSessionsMessage {
  type: 'sessions';
  sessions: Array<{ id: string; name: string; updatedAt: string }>;
  activeSessionId: string;
}

export interface ServerHistoryMessage {
  type: 'history';
  sessionId: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ServerSyncMessage {
  type: 'sync';
  userMessage: string;
  response: string;
  sessionId: string;
  tokensUsed?: number;
  media?: Array<{ type: string; filePath: string; mimeType: string }>;
  timestamp: string;
}

export interface ServerSchedulerMessage {
  type: 'scheduler';
  jobName: string;
  prompt: string;
  response: string;
  sessionId: string;
  timestamp: string;
}

export interface ServerErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

/**
 * Callback for cross-channel sync when messages are received via iOS
 */
export type iOSMessageCallback = (data: {
  userMessage: string;
  response: string;
  channel: 'ios';
  deviceId: string;
  sessionId: string;
  media?: Array<{ type: string; filePath: string; mimeType: string }>;
}) => void;

/**
 * Connected iOS device info
 */
export interface ConnectedDevice {
  deviceId: string;
  deviceName: string;
  connectedAt: Date;
  sessionId: string;
}

/**
 * Shared handler types used by both local server and relay client
 */
export type iOSMessageHandler = (
  client: { device: ConnectedDevice },
  message: ClientChatMessage
) => Promise<{ response: string; tokensUsed?: number; media?: Array<{ type: string; filePath: string; mimeType: string }> }>;

export type iOSSessionsHandler = () => Array<{ id: string; name: string; updatedAt: string }>;

export type iOSHistoryHandler = (sessionId: string, limit: number) => Array<{
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}>;

export type iOSStatusForwarder = (
  sessionId: string,
  handler: (status: ServerStatusMessage) => void
) => () => void;

// === Model types ===

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ServerModelsMessage {
  type: 'models';
  models: ModelInfo[];
  activeModelId: string;
}

export type iOSModelsHandler = () => { models: ModelInfo[]; activeModelId: string };

export type iOSModelSwitchHandler = (modelId: string) => void;

export type iOSStopHandler = (sessionId: string) => boolean;

export type iOSClearHandler = (sessionId: string) => void;

// === New feature handler types ===

export type iOSFactsHandler = () => Array<{ id: number; category: string; subject: string; content: string; created_at?: string; updated_at?: string }>;

export type iOSFactsDeleteHandler = (id: number) => boolean;

export type iOSDailyLogsHandler = (days?: number) => Array<{ id: number; date: string; content: string; updated_at?: string }>;

export type iOSSoulHandler = () => Array<{ id: number; aspect: string; content: string; created_at?: string; updated_at?: string }>;

export type iOSSoulDeleteHandler = (id: number) => boolean;

export type iOSFactsGraphHandler = () => Promise<{ nodes: Array<{ id: number; subject: string; category: string; content: string; group: number }>; links: Array<{ source: number; target: number; type: string; strength: number }> }>;

export type iOSCustomizeGetHandler = () => { identity: string; instructions: string };

export type iOSCustomizeSaveHandler = (identity?: string, instructions?: string) => void;

export type iOSRoutinesListHandler = () => Array<{ id: number; name: string; schedule_type?: string; schedule: string | null; run_at?: string | null; interval_ms?: number | null; prompt: string; channel: string; enabled: boolean; delete_after_run?: boolean; context_messages?: number; next_run_at?: string | null; session_id?: string | null; job_type?: string }>;

export type iOSRoutinesCreateHandler = (name: string, schedule: string, prompt: string, channel: string, sessionId: string) => Promise<boolean>;

export type iOSRoutinesDeleteHandler = (name: string) => boolean;

export type iOSRoutinesToggleHandler = (name: string, enabled: boolean) => boolean;

export type iOSRoutinesRunHandler = (name: string) => Promise<{ success: boolean; error?: string }>;

export type iOSAppInfoHandler = () => { version: string; name: string };

export type iOSModeGetHandler = (sessionId: string) => { mode: string; locked: boolean };

export type iOSModeSwitchHandler = (sessionId: string, mode: string) => { mode: string; locked: boolean; error?: string };

export interface ServerModeMessage {
  type: 'mode';
  mode: 'general' | 'coder';
  locked: boolean;
}
