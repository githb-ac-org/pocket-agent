/**
 * WebSocket protocol types for iOS channel communication.
 */

// === Messages from iOS → Desktop ===

export interface ClientMessage {
  type: 'message' | 'pair' | 'ping' | 'stop' | 'push_token' | 'sessions:list' | 'sessions:switch' | 'sessions:history' | 'sessions:clear' | 'workflows:list' | 'models:list' | 'models:switch';
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
}

export interface ServerSchedulerMessage {
  type: 'scheduler';
  jobName: string;
  prompt: string;
  response: string;
  sessionId: string;
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
