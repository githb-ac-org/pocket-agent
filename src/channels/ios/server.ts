/**
 * WebSocket server for iOS channel communication.
 *
 * Handles:
 * - Device pairing with 6-digit codes
 * - Authenticated connections via tokens
 * - Message routing to/from agent
 * - Status event forwarding
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import crypto from 'crypto';
import {
  ClientMessage,
  ClientChatMessage,
  ClientPairMessage,
  ServerStatusMessage,
  ServerResponseMessage,
  ServerPairResultMessage,
  ServerSessionsMessage,
  ServerErrorMessage,
  ConnectedDevice,
  iOSMessageHandler,
  iOSSessionsHandler,
  iOSHistoryHandler,
  iOSStatusForwarder,
  iOSModelsHandler,
  iOSModelSwitchHandler,
  iOSStopHandler,
  iOSClearHandler,
  iOSFactsHandler,
  iOSFactsDeleteHandler,
  iOSDailyLogsHandler,
  iOSSoulHandler,
  iOSSoulDeleteHandler,
  iOSFactsGraphHandler,
  iOSCustomizeGetHandler,
  iOSCustomizeSaveHandler,
  iOSRoutinesListHandler,
  iOSRoutinesCreateHandler,
  iOSRoutinesDeleteHandler,
  iOSRoutinesToggleHandler,
  iOSRoutinesRunHandler,
  iOSAppInfoHandler,
  iOSModeGetHandler,
  iOSModeSwitchHandler,
} from './types';
import { loadWorkflowCommands } from '../../config/commands-loader';
import { SettingsManager } from '../../settings';

const DEFAULT_PORT = 7888;
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

interface AuthenticatedClient {
  ws: WebSocket;
  device: ConnectedDevice;
}

export class iOSWebSocketServer {
  private wss: WebSocketServer | null = null;
  private port: number;
  private clients: Map<string, AuthenticatedClient> = new Map(); // authToken → client
  private authTokens: Map<string, { deviceId: string; deviceName: string; pushToken?: string }> = new Map(); // persistent tokens
  private pairingCodes: Map<string, { createdAt: number }> = new Map(); // active pairing codes
  private activePairingCode: string | null = null;

  private onMessage: iOSMessageHandler | null = null;
  private onGetSessions: iOSSessionsHandler | null = null;
  private onGetHistory: iOSHistoryHandler | null = null;
  private onStatusSubscribe: iOSStatusForwarder | null = null;
  private onGetModels: iOSModelsHandler | null = null;
  private onSwitchModel: iOSModelSwitchHandler | null = null;
  private onStop: iOSStopHandler | null = null;
  private onClear: iOSClearHandler | null = null;
  private onGetFacts: iOSFactsHandler | null = null;
  private onDeleteFact: iOSFactsDeleteHandler | null = null;
  private onGetDailyLogs: iOSDailyLogsHandler | null = null;
  private onGetSoul: iOSSoulHandler | null = null;
  private onDeleteSoulAspect: iOSSoulDeleteHandler | null = null;
  private onGetFactsGraph: iOSFactsGraphHandler | null = null;
  private onGetCustomize: iOSCustomizeGetHandler | null = null;
  private onSaveCustomize: iOSCustomizeSaveHandler | null = null;
  private onGetRoutines: iOSRoutinesListHandler | null = null;
  private onCreateRoutine: iOSRoutinesCreateHandler | null = null;
  private onDeleteRoutine: iOSRoutinesDeleteHandler | null = null;
  private onToggleRoutine: iOSRoutinesToggleHandler | null = null;
  private onRunRoutine: iOSRoutinesRunHandler | null = null;
  private onGetAppInfo: iOSAppInfoHandler | null = null;
  private onSkinSet: ((skinId: string) => void) | null = null;
  private onGetMode: iOSModeGetHandler | null = null;
  private onSwitchMode: iOSModeSwitchHandler | null = null;

  constructor(port?: number) {
    this.port = port || DEFAULT_PORT;
    this.loadPairedDevices();
  }

  private loadPairedDevices(): void {
    try {
      const raw = SettingsManager.get('ios.pairedDevices');
      if (!raw) return;
      const devices: Array<{ token: string; deviceId: string; deviceName: string; pushToken?: string }> = JSON.parse(raw);
      for (const d of devices) {
        this.authTokens.set(d.token, { deviceId: d.deviceId, deviceName: d.deviceName, pushToken: d.pushToken });
      }
      if (devices.length > 0) {
        console.log(`[iOS] Loaded ${devices.length} paired device(s)`);
      }
    } catch {
      // corrupt data, ignore
    }
  }

  private savePairedDevices(): void {
    const devices = Array.from(this.authTokens.entries()).map(([token, info]) => ({
      token,
      deviceId: info.deviceId,
      deviceName: info.deviceName,
      ...(info.pushToken ? { pushToken: info.pushToken } : {}),
    }));
    SettingsManager.set('ios.pairedDevices', JSON.stringify(devices));
  }

  /**
   * Set handler for incoming chat messages
   */
  setMessageHandler(handler: iOSMessageHandler): void {
    this.onMessage = handler;
  }

  /**
   * Set handler for session list requests
   */
  setSessionsHandler(handler: iOSSessionsHandler): void {
    this.onGetSessions = handler;
  }

  /**
   * Set handler for history requests
   */
  setHistoryHandler(handler: iOSHistoryHandler): void {
    this.onGetHistory = handler;
  }

  /**
   * Set handler for subscribing to agent status events
   */
  setStatusForwarder(forwarder: iOSStatusForwarder): void {
    this.onStatusSubscribe = forwarder;
  }

  setModelsHandler(handler: iOSModelsHandler): void {
    this.onGetModels = handler;
  }

  setModelSwitchHandler(handler: iOSModelSwitchHandler): void {
    this.onSwitchModel = handler;
  }

  setStopHandler(handler: iOSStopHandler): void {
    this.onStop = handler;
  }

  setClearHandler(handler: iOSClearHandler): void {
    this.onClear = handler;
  }

  setFactsHandler(handler: iOSFactsHandler): void { this.onGetFacts = handler; }
  setFactsDeleteHandler(handler: iOSFactsDeleteHandler): void { this.onDeleteFact = handler; }
  setDailyLogsHandler(handler: iOSDailyLogsHandler): void { this.onGetDailyLogs = handler; }
  setSoulHandler(handler: iOSSoulHandler): void { this.onGetSoul = handler; }
  setSoulDeleteHandler(handler: iOSSoulDeleteHandler): void { this.onDeleteSoulAspect = handler; }
  setFactsGraphHandler(handler: iOSFactsGraphHandler): void { this.onGetFactsGraph = handler; }
  setCustomizeGetHandler(handler: iOSCustomizeGetHandler): void { this.onGetCustomize = handler; }
  setCustomizeSaveHandler(handler: iOSCustomizeSaveHandler): void { this.onSaveCustomize = handler; }
  setRoutinesListHandler(handler: iOSRoutinesListHandler): void { this.onGetRoutines = handler; }
  setRoutinesCreateHandler(handler: iOSRoutinesCreateHandler): void { this.onCreateRoutine = handler; }
  setRoutinesDeleteHandler(handler: iOSRoutinesDeleteHandler): void { this.onDeleteRoutine = handler; }
  setRoutinesToggleHandler(handler: iOSRoutinesToggleHandler): void { this.onToggleRoutine = handler; }
  setRoutinesRunHandler(handler: iOSRoutinesRunHandler): void { this.onRunRoutine = handler; }
  setAppInfoHandler(handler: iOSAppInfoHandler): void { this.onGetAppInfo = handler; }
  setSkinHandler(handler: (skinId: string) => void): void { this.onSkinSet = handler; }
  setModeGetHandler(handler: iOSModeGetHandler): void { this.onGetMode = handler; }
  setModeSwitchHandler(handler: iOSModeSwitchHandler): void { this.onSwitchMode = handler; }

  /**
   * Generate a new 6-digit pairing code
   */
  generatePairingCode(): string {
    // Clear any existing code
    if (this.activePairingCode) {
      this.pairingCodes.delete(this.activePairingCode);
    }

    const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
    const code = Array.from(bytes, (b) => (b % 10).toString()).join('');

    this.pairingCodes.set(code, { createdAt: Date.now() });
    this.activePairingCode = code;

    // Auto-expire
    setTimeout(() => {
      this.pairingCodes.delete(code);
      if (this.activePairingCode === code) {
        this.activePairingCode = null;
      }
    }, PAIRING_CODE_EXPIRY_MS);

    return code;
  }

  /**
   * Get the current active pairing code (or generate one)
   */
  getActivePairingCode(): string {
    if (this.activePairingCode && this.pairingCodes.has(this.activePairingCode)) {
      return this.activePairingCode;
    }
    return this.generatePairingCode();
  }

  /**
   * Send a message to a specific device
   */
  sendToDevice(deviceId: string, message: object): boolean {
    for (const client of this.clients.values()) {
      if (client.device.deviceId === deviceId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
        return true;
      }
    }
    return false;
  }

  /**
   * Broadcast to all connected iOS clients
   */
  broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  async sendPushNotifications(title: string, body: string, data?: Record<string, string>): Promise<void> {
    const tokens: string[] = [];
    for (const info of this.authTokens.values()) {
      if (info.pushToken) tokens.push(info.pushToken);
    }
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      title,
      body: body.length > 200 ? body.substring(0, 200) + '...' : body,
      sound: 'pocket-agent-notif.mp3',
      categoryId: 'REPLY',
      ...(data ? { data } : {}),
    }));

    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!resp.ok) {
        console.error(`[iOS] Push failed: ${resp.status}`);
      }
    } catch (err) {
      console.error('[iOS] Push error:', err);
    }
  }

  /**
   * Get list of connected devices
   */
  getConnectedDevices(): ConnectedDevice[] {
    return Array.from(this.clients.values()).map((c) => c.device);
  }

  /**
   * Start the WebSocket server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });

        this.wss.on('listening', () => {
          console.log(`[iOS] WebSocket server listening on port ${this.port}`);
          resolve();
        });

        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (error: Error) => {
          console.error('[iOS] WebSocket server error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the WebSocket server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.close();
      }
      this.clients.clear();

      this.wss.close(() => {
        console.log('[iOS] WebSocket server stopped');
        this.wss = null;
        resolve();
      });
    });
  }

  get isRunning(): boolean {
    return this.wss !== null;
  }

  /**
   * Handle a new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const token = url.searchParams.get('token');

    console.log('[iOS] New connection attempt');

    // Check if this is an authenticated reconnection
    if (token && this.authTokens.has(token)) {
      const deviceInfo = this.authTokens.get(token)!;
      const client: AuthenticatedClient = {
        ws,
        device: {
          deviceId: deviceInfo.deviceId,
          deviceName: deviceInfo.deviceName,
          connectedAt: new Date(),
          sessionId: 'default',
        },
      };
      this.clients.set(token, client);
      console.log(`[iOS] Authenticated device reconnected: ${deviceInfo.deviceName}`);
      this.setupClientHandlers(ws, token, client);
      return;
    }

    // Unauthenticated connection - only allow pairing messages
    this.setupPairingHandlers(ws);
  }

  /**
   * Set up handlers for unauthenticated connections (pairing only)
   */
  private setupPairingHandlers(ws: WebSocket): void {
    const timeout = setTimeout(() => {
      ws.close(4001, 'Pairing timeout');
    }, 30000);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (message.type === 'pair') {
          clearTimeout(timeout);
          this.handlePairing(ws, message as ClientPairMessage);
        } else if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  }

  /**
   * Handle a pairing request
   */
  private handlePairing(ws: WebSocket, message: ClientPairMessage): void {
    const { pairingCode, deviceName } = message;

    if (!this.pairingCodes.has(pairingCode)) {
      const result: ServerPairResultMessage = {
        type: 'pair_result',
        success: false,
        error: 'Invalid or expired pairing code',
      };
      ws.send(JSON.stringify(result));
      ws.close();
      return;
    }

    // Valid code - create auth token and device ID
    const authToken = crypto.randomBytes(32).toString('hex');
    const deviceId = crypto.randomUUID();

    // Store persistent auth
    this.authTokens.set(authToken, { deviceId, deviceName });
    this.savePairedDevices();

    // Remove used pairing code
    this.pairingCodes.delete(pairingCode);
    this.activePairingCode = null;

    // Set up as authenticated client
    const client: AuthenticatedClient = {
      ws,
      device: {
        deviceId,
        deviceName,
        connectedAt: new Date(),
        sessionId: 'default',
      },
    };
    this.clients.set(authToken, client);

    // Send success
    const result: ServerPairResultMessage = {
      type: 'pair_result',
      success: true,
      authToken,
      deviceId,
    };
    ws.send(JSON.stringify(result));

    console.log(`[iOS] Device paired: ${deviceName} (${deviceId})`);

    // Set up message handlers
    this.setupClientHandlers(ws, authToken, client);
  }

  /**
   * Set up handlers for authenticated clients
   */
  private setupClientHandlers(ws: WebSocket, authToken: string, client: AuthenticatedClient): void {
    let statusUnsubscribe: (() => void) | null = null;

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;

        switch (message.type) {
          case 'message':
            await this.handleChatMessage(client, message as ClientChatMessage);
            break;

          case 'sessions:list':
            this.handleSessionsList(client);
            break;

          case 'sessions:switch':
            if ('sessionId' in message) {
              client.device.sessionId = (message as { sessionId: string }).sessionId;
            }
            break;

          case 'sessions:history': {
            const histSessionId = ('sessionId' in message ? (message as { sessionId: string }).sessionId : client.device.sessionId) || 'default';
            const histLimit = ('limit' in message ? (message as { limit: number }).limit : 100) || 100;
            const histMessages = this.onGetHistory?.(histSessionId, histLimit) || [];
            ws.send(JSON.stringify({ type: 'history', sessionId: histSessionId, messages: histMessages }));
            break;
          }

          case 'sessions:clear': {
            if ('sessionId' in message) {
              const clearSessionId = (message as { sessionId: string }).sessionId;
              this.onClear?.(clearSessionId);
              // Send back empty history to confirm the clear
              ws.send(JSON.stringify({ type: 'history', sessionId: clearSessionId, messages: [] }));
            }
            break;
          }

          case 'workflows:list': {
            const commands = loadWorkflowCommands();
            const workflows = commands.map(c => ({ name: c.name, description: c.description, content: c.content }));
            ws.send(JSON.stringify({ type: 'workflows', workflows }));
            break;
          }

          case 'models:list': {
            const modelsResult = this.onGetModels?.() || { models: [], activeModelId: '' };
            ws.send(JSON.stringify({ type: 'models', ...modelsResult }));
            break;
          }

          case 'models:switch': {
            if ('modelId' in message) {
              this.onSwitchModel?.((message as { modelId: string }).modelId);
              // Send updated model list back
              const updatedModels = this.onGetModels?.() || { models: [], activeModelId: '' };
              ws.send(JSON.stringify({ type: 'models', ...updatedModels }));
            }
            break;
          }

          case 'stop':
            if (client.device.sessionId && this.onStop) {
              this.onStop(client.device.sessionId);
              // Immediately confirm stop so iOS clears the processing state
              ws.send(JSON.stringify({
                type: 'status',
                status: 'done',
                sessionId: client.device.sessionId,
              }));
            }
            break;

          case 'push_token':
            if ('pushToken' in message) {
              const tokenInfo = this.authTokens.get(authToken);
              if (tokenInfo) {
                tokenInfo.pushToken = (message as { pushToken: string }).pushToken;
                this.savePairedDevices();
                console.log(`[iOS] Push token saved for ${client.device.deviceName}`);
              }
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'facts:list': {
            const facts = this.onGetFacts?.() || [];
            ws.send(JSON.stringify({ type: 'facts', facts }));
            break;
          }
          case 'facts:delete': {
            if ('id' in message) {
              this.onDeleteFact?.((message as unknown as { id: number }).id);
              const updatedFacts = this.onGetFacts?.() || [];
              ws.send(JSON.stringify({ type: 'facts', facts: updatedFacts }));
            }
            break;
          }
          case 'daily-logs:list': {
            const days = 'days' in message ? (message as { days: number }).days : undefined;
            const logs = this.onGetDailyLogs?.(days) || [];
            ws.send(JSON.stringify({ type: 'daily-logs', logs }));
            break;
          }
          case 'soul:list': {
            const aspects = this.onGetSoul?.() || [];
            ws.send(JSON.stringify({ type: 'soul', aspects }));
            break;
          }
          case 'soul:delete': {
            if ('id' in message) {
              this.onDeleteSoulAspect?.((message as unknown as { id: number }).id);
              const updatedAspects = this.onGetSoul?.() || [];
              ws.send(JSON.stringify({ type: 'soul', aspects: updatedAspects }));
            }
            break;
          }
          case 'facts:graph': {
            this.onGetFactsGraph?.().then((graph) => {
              ws.send(JSON.stringify({ type: 'facts:graph', ...graph }));
            }).catch(() => {
              ws.send(JSON.stringify({ type: 'facts:graph', nodes: [], links: [] }));
            });
            break;
          }
          case 'customize:get': {
            const customize = this.onGetCustomize?.() || { identity: '', instructions: '' };
            ws.send(JSON.stringify({ type: 'customize', ...customize }));
            break;
          }
          case 'customize:save': {
            const identity = 'identity' in message ? (message as { identity: string }).identity : undefined;
            const instructions = 'instructions' in message ? (message as { instructions: string }).instructions : undefined;
            this.onSaveCustomize?.(identity, instructions);
            const updated = this.onGetCustomize?.() || { identity: '', instructions: '' };
            ws.send(JSON.stringify({ type: 'customize', ...updated }));
            break;
          }
          case 'routines:list': {
            const jobs = this.onGetRoutines?.() || [];
            ws.send(JSON.stringify({ type: 'routines', jobs }));
            break;
          }
          case 'routines:create': {
            const m = message as unknown as { name: string; schedule: string; prompt: string; channel: string; sessionId: string };
            this.onCreateRoutine?.(m.name, m.schedule, m.prompt, m.channel || 'default', m.sessionId || 'default').then(() => {
              const updatedJobs = this.onGetRoutines?.() || [];
              ws.send(JSON.stringify({ type: 'routines', jobs: updatedJobs }));
            }).catch(() => {
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to create routine' }));
            });
            break;
          }
          case 'routines:delete': {
            if ('name' in message) {
              this.onDeleteRoutine?.((message as { name: string }).name);
              const updatedJobs = this.onGetRoutines?.() || [];
              ws.send(JSON.stringify({ type: 'routines', jobs: updatedJobs }));
            }
            break;
          }
          case 'routines:toggle': {
            const toggleMsg = message as unknown as { name: string; enabled: boolean };
            this.onToggleRoutine?.(toggleMsg.name, toggleMsg.enabled);
            const updatedJobs = this.onGetRoutines?.() || [];
            ws.send(JSON.stringify({ type: 'routines', jobs: updatedJobs }));
            break;
          }
          case 'routines:run': {
            if ('name' in message) {
              const routineName = (message as { name: string }).name;
              this.onRunRoutine?.(routineName).then((result) => {
                ws.send(JSON.stringify({ type: 'routine:result', name: routineName, ...result }));
              }).catch((err) => {
                ws.send(JSON.stringify({ type: 'routine:result', name: routineName, success: false, error: String(err) }));
              });
            }
            break;
          }
          case 'app:info': {
            const info = this.onGetAppInfo?.() || { version: 'unknown', name: 'Pocket Agent' };
            ws.send(JSON.stringify({ type: 'app:info', ...info }));
            break;
          }
          case 'skin:set': {
            if ('skinId' in message) {
              const skinId = (message as { skinId: string }).skinId;
              this.onSkinSet?.(skinId);
            }
            break;
          }
          case 'mode:get': {
            const sessionId = client.device.sessionId || 'default';
            const modeResult = this.onGetMode?.(sessionId) || { mode: 'coder', locked: false };
            ws.send(JSON.stringify({ type: 'mode', mode: modeResult.mode, locked: modeResult.locked }));
            break;
          }
          case 'mode:switch': {
            if ('mode' in message) {
              const newMode = (message as { mode: string }).mode;
              const sessionId = client.device.sessionId || 'default';
              const result = this.onSwitchMode?.(sessionId, newMode) || { mode: newMode, locked: false };
              ws.send(JSON.stringify({ type: 'mode', mode: result.mode, locked: result.locked }));
            }
            break;
          }
        }
      } catch (error) {
        console.error('[iOS] Error handling message:', error);
        const errorMsg: ServerErrorMessage = {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
        ws.send(JSON.stringify(errorMsg));
      }
    });

    ws.on('close', () => {
      console.log(`[iOS] Device disconnected: ${client.device.deviceName}`);
      this.clients.delete(authToken);
      if (statusUnsubscribe) {
        statusUnsubscribe();
      }
    });

    // Subscribe to status events for this client
    if (this.onStatusSubscribe) {
      statusUnsubscribe = this.onStatusSubscribe(
        client.device.sessionId,
        (status: ServerStatusMessage) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(status));
          }
        }
      );
    }
  }

  /**
   * Handle an incoming chat message from iOS
   */
  private async handleChatMessage(client: AuthenticatedClient, message: ClientChatMessage): Promise<void> {
    if (!this.onMessage) {
      const error: ServerErrorMessage = {
        type: 'error',
        message: 'Agent not available',
      };
      client.ws.send(JSON.stringify(error));
      return;
    }

    try {
      const result = await this.onMessage(client, message);
      // Skip sending empty responses (e.g. from abort/stop)
      if (!result.response) return;

      const response: ServerResponseMessage = {
        type: 'response',
        text: result.response,
        sessionId: message.sessionId,
        tokensUsed: result.tokensUsed,
        media: result.media,
      };
      client.ws.send(JSON.stringify(response));
    } catch (error) {
      // Don't send abort errors — these are intentional stops from the user
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('aborted') || msg.includes('interrupted')) return;

      const errorMsg: ServerErrorMessage = {
        type: 'error',
        message: msg || 'Failed to process message',
      };
      client.ws.send(JSON.stringify(errorMsg));
    }
  }

  /**
   * Handle sessions list request
   */
  private handleSessionsList(client: AuthenticatedClient): void {
    const sessions = this.onGetSessions?.() || [];
    const msg: ServerSessionsMessage = {
      type: 'sessions',
      sessions,
      activeSessionId: client.device.sessionId,
    };
    client.ws.send(JSON.stringify(msg));
  }
}
