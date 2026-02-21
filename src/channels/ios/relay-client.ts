/**
 * Relay client for iOS channel communication.
 *
 * Connects to the Cloudflare Workers relay as a "host".
 * iOS devices connect to the same relay as "clients".
 * The relay forwards messages bidirectionally.
 *
 * Maintains same interface as iOSWebSocketServer for drop-in use.
 */

import WebSocket from 'ws';
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
} from './types';
import { loadWorkflowCommands } from '../../config/commands-loader';
import { SettingsManager } from '../../settings';

const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25000;

interface VirtualClient {
  relayClientId: string;
  device: ConnectedDevice;
  authToken: string;
  statusUnsubscribe?: () => void;
}

export class iOSRelayClient {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private instanceId: string;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Virtual clients tracked by relay clientId
  private clients: Map<string, VirtualClient> = new Map();
  // Auth tokens → device info (persistent across reconnects)
  private authTokens: Map<string, { deviceId: string; deviceName: string; relayClientId?: string; pushToken?: string }> = new Map();
  // Reverse map: relay client ID → auth token (tracks all IDs per device)
  private relayIdToToken: Map<string, string> = new Map();
  // Pairing codes
  private pairingCodes: Map<string, { createdAt: number }> = new Map();
  private activePairingCode: string | null = null;
  // Unauthenticated relay clients (for pairing)
  private pendingClients: Set<string> = new Set();

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

  private _isRunning = false;

  constructor(relayUrl: string, instanceId: string) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.instanceId = instanceId;
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
        console.log(`[iOS Relay] Loaded ${devices.length} paired device(s)`);
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

  setMessageHandler(handler: iOSMessageHandler): void {
    this.onMessage = handler;
  }

  setSessionsHandler(handler: iOSSessionsHandler): void {
    this.onGetSessions = handler;
  }

  setHistoryHandler(handler: iOSHistoryHandler): void {
    this.onGetHistory = handler;
  }

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

  generatePairingCode(): string {
    if (this.activePairingCode) {
      this.pairingCodes.delete(this.activePairingCode);
    }

    const code = Array.from({ length: PAIRING_CODE_LENGTH }, () =>
      Math.floor(Math.random() * 10)
    ).join('');

    this.pairingCodes.set(code, { createdAt: Date.now() });
    this.activePairingCode = code;

    setTimeout(() => {
      this.pairingCodes.delete(code);
      if (this.activePairingCode === code) {
        this.activePairingCode = null;
      }
    }, PAIRING_CODE_EXPIRY_MS);

    return code;
  }

  getActivePairingCode(): string {
    if (this.activePairingCode && this.pairingCodes.has(this.activePairingCode)) {
      return this.activePairingCode;
    }
    return this.generatePairingCode();
  }

  sendToDevice(deviceId: string, message: object): boolean {
    for (const client of this.clients.values()) {
      if (client.device.deviceId === deviceId) {
        this.sendToRelay(client.relayClientId, message);
        return true;
      }
    }
    return false;
  }

  broadcast(message: object): void {
    // Send without _to → relay broadcasts to all clients
    this.sendRaw(JSON.stringify(message));
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
        console.error(`[iOS Relay] Push failed: ${resp.status}`);
      }
    } catch (err) {
      console.error('[iOS Relay] Push error:', err);
    }
  }

  getConnectedDevices(): ConnectedDevice[] {
    return Array.from(this.clients.values()).map((c) => c.device);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    this.shouldReconnect = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this._isRunning = false;
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Clean up status subscriptions
    for (const client of this.clients.values()) {
      if (client.statusUnsubscribe) {
        client.statusUnsubscribe();
      }
    }
    this.clients.clear();
    this.pendingClients.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log('[iOS Relay] Disconnected');
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.relayUrl}/room/${this.instanceId}?role=host`;
      console.log(`[iOS Relay] Connecting to ${url}`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('[iOS Relay] Connected to relay');
        this.startPing();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleRelayMessage(data.toString());
      });

      this.ws.on('close', () => {
        console.log('[iOS Relay] Connection closed');
        this.stopPing();
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        console.error('[iOS Relay] Connection error:', error.message);
        if (!this._isRunning) {
          reject(error);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[iOS Relay] Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.error('[iOS Relay] Reconnect failed:', err.message);
      });
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Send a message to a specific relay client
   */
  private sendToRelay(relayClientId: string, message: object): void {
    const envelope = { ...message, _to: relayClientId };
    this.sendRaw(JSON.stringify(envelope));
  }

  private sendRaw(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Handle incoming message from relay (either from a client or relay control message)
   */
  private handleRelayMessage(raw: string): void {
    try {
      const data = JSON.parse(raw);
      const from: string | undefined = data._from;
      const relayEvent: string | undefined = data._relay;

      // Relay control messages
      if (relayEvent === 'client_connected' && from) {
        const token: string | undefined = data.token;
        if (token && this.authTokens.has(token)) {
          // Track this relay ID → token mapping
          this.relayIdToToken.set(from, token);
          // Re-authenticate: map new relayClientId to existing device
          const deviceInfo = this.authTokens.get(token)!;
          deviceInfo.relayClientId = from;
          // Reuse existing client if present (preserve session), otherwise create new
          const existing = this.clients.get(token);
          if (existing) {
            existing.relayClientId = from;
          } else {
            const virtualClient: VirtualClient = {
              relayClientId: from,
              device: {
                deviceId: deviceInfo.deviceId,
                deviceName: deviceInfo.deviceName,
                connectedAt: new Date(),
                sessionId: 'default',
              },
              authToken: token,
            };
            this.clients.set(token, virtualClient);
            this.subscribeClientStatus(virtualClient);
          }
          console.log(`[iOS Relay] Device reconnected: ${deviceInfo.deviceName}`);
        } else {
          this.pendingClients.add(from);
        }
        return;
      }
      if (relayEvent === 'client_disconnected' && from) {
        this.handleClientDisconnect(from);
        return;
      }

      if (!from) return;

      // Remove relay metadata before processing
      delete data._from;
      delete data._relay;

      const message = data as ClientMessage;

      // Check if this is from an authenticated client
      const client = this.findClientByRelayId(from);
      if (client) {
        this.handleAuthenticatedMessage(client, message);
        return;
      }

      // Check if this relay client has a stored auth token
      if (message.type === 'ping') {
        this.sendToRelay(from, { type: 'pong' });
        return;
      }

      // Unauthenticated - only pairing allowed
      if (message.type === 'pair') {
        this.handlePairing(from, message as ClientPairMessage);
      }
    } catch (error) {
      console.error('[iOS Relay] Error parsing message:', error);
    }
  }

  private findClientByRelayId(relayClientId: string): VirtualClient | undefined {
    for (const client of this.clients.values()) {
      if (client.relayClientId === relayClientId) {
        return client;
      }
    }
    // Fallback: check reverse map for older relay IDs belonging to the same device
    const token = this.relayIdToToken.get(relayClientId);
    if (token) {
      const client = this.clients.get(token);
      if (client) {
        // Update to the relay ID that's actually sending — this is the live connection
        client.relayClientId = relayClientId;
        return client;
      }
    }
    return undefined;
  }

  private handleClientDisconnect(relayClientId: string): void {
    this.pendingClients.delete(relayClientId);
    this.relayIdToToken.delete(relayClientId);
    // Only disconnect if this is the client's current relay ID (not a stale one)
    for (const [token, client] of this.clients.entries()) {
      if (client.relayClientId === relayClientId) {
        console.log(`[iOS Relay] Device disconnected: ${client.device.deviceName}`);
        if (client.statusUnsubscribe) {
          client.statusUnsubscribe();
        }
        this.clients.delete(token);
        // Keep authToken for reconnection
        break;
      }
    }
  }

  private handlePairing(relayClientId: string, message: ClientPairMessage): void {
    const { pairingCode, deviceName } = message;

    if (!this.pairingCodes.has(pairingCode)) {
      const result: ServerPairResultMessage = {
        type: 'pair_result',
        success: false,
        error: 'Invalid or expired pairing code',
      };
      this.sendToRelay(relayClientId, result);
      return;
    }

    // Valid code - create auth token
    const authToken = crypto.randomBytes(32).toString('hex');
    const deviceId = crypto.randomUUID();

    this.authTokens.set(authToken, { deviceId, deviceName, relayClientId });
    this.pairingCodes.delete(pairingCode);
    this.activePairingCode = null;

    const virtualClient: VirtualClient = {
      relayClientId,
      device: {
        deviceId,
        deviceName,
        connectedAt: new Date(),
        sessionId: 'default',
      },
      authToken,
    };
    this.clients.set(authToken, virtualClient);
    this.relayIdToToken.set(relayClientId, authToken);
    this.pendingClients.delete(relayClientId);

    // Send success
    const result: ServerPairResultMessage = {
      type: 'pair_result',
      success: true,
      authToken,
      deviceId,
    };
    this.sendToRelay(relayClientId, result);

    console.log(`[iOS Relay] Device paired: ${deviceName} (${deviceId})`);
    this.savePairedDevices();

    // Subscribe to status events
    this.subscribeClientStatus(virtualClient);
  }

  private handleAuthenticatedMessage(client: VirtualClient, message: ClientMessage): void {
    switch (message.type) {
      case 'message':
        this.handleChatMessage(client, message as ClientChatMessage);
        break;
      case 'sessions:list':
        this.handleSessionsList(client);
        break;
      case 'sessions:switch':
        if ('sessionId' in message) {
          client.device.sessionId = (message as { sessionId: string }).sessionId;
          // Re-subscribe status for new session
          if (client.statusUnsubscribe) {
            client.statusUnsubscribe();
          }
          this.subscribeClientStatus(client);
        }
        break;
      case 'sessions:history':
        this.handleSessionsHistory(client, message);
        break;
      case 'sessions:clear':
        if ('sessionId' in message) {
          const clearSessionId = (message as { sessionId: string }).sessionId;
          this.onClear?.(clearSessionId);
          // Send back empty history to confirm the clear
          this.sendToRelay(client.relayClientId, { type: 'history', sessionId: clearSessionId, messages: [] });
        }
        break;
      case 'workflows:list':
        this.handleWorkflowsList(client);
        break;
      case 'models:list':
        this.handleModelsList(client);
        break;
      case 'models:switch':
        if ('modelId' in message) {
          this.onSwitchModel?.((message as { modelId: string }).modelId);
          // Send updated model list back
          this.handleModelsList(client);
        }
        break;
      case 'stop':
        if (client.device.sessionId && this.onStop) {
          this.onStop(client.device.sessionId);
          // Immediately confirm stop so iOS clears the processing state
          this.sendToRelay(client.relayClientId, {
            type: 'status',
            status: 'done',
            sessionId: client.device.sessionId,
          });
        }
        break;
      case 'push_token':
        if ('pushToken' in message) {
          const tokenInfo = this.authTokens.get(client.authToken);
          if (tokenInfo) {
            tokenInfo.pushToken = (message as { pushToken: string }).pushToken;
            this.savePairedDevices();
            console.log(`[iOS Relay] Push token saved for ${client.device.deviceName}`);
          }
        }
        break;
      case 'ping':
        this.sendToRelay(client.relayClientId, { type: 'pong' });
        break;
      case 'facts:list': {
        const facts = this.onGetFacts?.() || [];
        this.sendToRelay(client.relayClientId, { type: 'facts', facts });
        break;
      }
      case 'facts:delete': {
        if ('id' in message) {
          this.onDeleteFact?.((message as unknown as { id: number }).id);
          const updatedFacts = this.onGetFacts?.() || [];
          this.sendToRelay(client.relayClientId, { type: 'facts', facts: updatedFacts });
        }
        break;
      }
      case 'daily-logs:list': {
        const days = 'days' in message ? (message as { days: number }).days : undefined;
        const logs = this.onGetDailyLogs?.(days) || [];
        this.sendToRelay(client.relayClientId, { type: 'daily-logs', logs });
        break;
      }
      case 'soul:list': {
        const aspects = this.onGetSoul?.() || [];
        this.sendToRelay(client.relayClientId, { type: 'soul', aspects });
        break;
      }
      case 'soul:delete': {
        if ('id' in message) {
          this.onDeleteSoulAspect?.((message as unknown as { id: number }).id);
          const updatedAspects = this.onGetSoul?.() || [];
          this.sendToRelay(client.relayClientId, { type: 'soul', aspects: updatedAspects });
        }
        break;
      }
      case 'facts:graph': {
        this.onGetFactsGraph?.().then((graph) => {
          this.sendToRelay(client.relayClientId, { type: 'facts:graph', ...graph });
        }).catch(() => {
          this.sendToRelay(client.relayClientId, { type: 'facts:graph', nodes: [], links: [] });
        });
        break;
      }
      case 'customize:get': {
        const customize = this.onGetCustomize?.() || { identity: '', instructions: '' };
        this.sendToRelay(client.relayClientId, { type: 'customize', ...customize });
        break;
      }
      case 'customize:save': {
        const identity = 'identity' in message ? (message as { identity: string }).identity : undefined;
        const instructions = 'instructions' in message ? (message as { instructions: string }).instructions : undefined;
        this.onSaveCustomize?.(identity, instructions);
        const updated = this.onGetCustomize?.() || { identity: '', instructions: '' };
        this.sendToRelay(client.relayClientId, { type: 'customize', ...updated });
        break;
      }
      case 'routines:list': {
        const jobs = this.onGetRoutines?.() || [];
        this.sendToRelay(client.relayClientId, { type: 'routines', jobs });
        break;
      }
      case 'routines:create': {
        const m = message as unknown as { name: string; schedule: string; prompt: string; channel: string; sessionId: string };
        this.onCreateRoutine?.(m.name, m.schedule, m.prompt, m.channel || 'default', m.sessionId || 'default').then(() => {
          const updatedJobs = this.onGetRoutines?.() || [];
          this.sendToRelay(client.relayClientId, { type: 'routines', jobs: updatedJobs });
        }).catch(() => {
          this.sendToRelay(client.relayClientId, { type: 'error', message: 'Failed to create routine' });
        });
        break;
      }
      case 'routines:delete': {
        if ('name' in message) {
          this.onDeleteRoutine?.((message as { name: string }).name);
          const updatedJobs = this.onGetRoutines?.() || [];
          this.sendToRelay(client.relayClientId, { type: 'routines', jobs: updatedJobs });
        }
        break;
      }
      case 'routines:toggle': {
        const toggleMsg = message as unknown as { name: string; enabled: boolean };
        this.onToggleRoutine?.(toggleMsg.name, toggleMsg.enabled);
        const updatedJobs = this.onGetRoutines?.() || [];
        this.sendToRelay(client.relayClientId, { type: 'routines', jobs: updatedJobs });
        break;
      }
      case 'routines:run': {
        if ('name' in message) {
          const routineName = (message as { name: string }).name;
          this.onRunRoutine?.(routineName).then((result) => {
            this.sendToRelay(client.relayClientId, { type: 'routine:result', name: routineName, ...result });
          }).catch((err) => {
            this.sendToRelay(client.relayClientId, { type: 'routine:result', name: routineName, success: false, error: String(err) });
          });
        }
        break;
      }
      case 'app:info': {
        const info = this.onGetAppInfo?.() || { version: 'unknown', name: 'Pocket Agent' };
        this.sendToRelay(client.relayClientId, { type: 'app:info', ...info });
        break;
      }
    }
  }

  private handleWorkflowsList(client: VirtualClient): void {
    const commands = loadWorkflowCommands();
    const workflows = commands.map(c => ({ name: c.name, description: c.description, content: c.content }));
    console.log(`[iOS Relay] Sending ${workflows.length} workflows to ${client.device.deviceName}:`, workflows.map(w => w.name));
    this.sendToRelay(client.relayClientId, { type: 'workflows', workflows });
  }

  private handleModelsList(client: VirtualClient): void {
    const result = this.onGetModels?.() || { models: [], activeModelId: '' };
    this.sendToRelay(client.relayClientId, { type: 'models', ...result });
  }

  private handleSessionsHistory(client: VirtualClient, message: ClientMessage): void {
    const sessionId = ('sessionId' in message ? (message as { sessionId: string }).sessionId : client.device.sessionId) || 'default';
    const limit = ('limit' in message ? (message as { limit: number }).limit : 100) || 100;
    const messages = this.onGetHistory?.(sessionId, limit) || [];
    this.sendToRelay(client.relayClientId, { type: 'history', sessionId, messages });
  }

  private async handleChatMessage(client: VirtualClient, message: ClientChatMessage): Promise<void> {
    if (!this.onMessage) {
      const error: ServerErrorMessage = { type: 'error', message: 'Agent not available' };
      this.sendToRelay(client.relayClientId, error);
      return;
    }

    // Keep status subscription in sync with the session being used
    if (message.sessionId && message.sessionId !== client.device.sessionId) {
      client.device.sessionId = message.sessionId;
      if (client.statusUnsubscribe) {
        client.statusUnsubscribe();
      }
      this.subscribeClientStatus(client);
    }

    try {
      const result = await this.onMessage({ device: client.device }, message);
      // Skip sending empty responses (e.g. from abort/stop)
      if (!result.response) return;
      const response: ServerResponseMessage = {
        type: 'response',
        text: result.response,
        sessionId: message.sessionId,
        tokensUsed: result.tokensUsed,
        media: result.media,
      };
      this.sendToRelay(client.relayClientId, response);
    } catch (error) {
      // Don't send abort errors to iOS — these are intentional stops from the user
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('aborted') || msg.includes('interrupted')) return;

      const errorMsg: ServerErrorMessage = {
        type: 'error',
        message: msg || 'Failed to process message',
      };
      this.sendToRelay(client.relayClientId, errorMsg);
    }
  }

  private handleSessionsList(client: VirtualClient): void {
    const sessions = this.onGetSessions?.() || [];
    const msg: ServerSessionsMessage = {
      type: 'sessions',
      sessions,
      activeSessionId: client.device.sessionId,
    };
    this.sendToRelay(client.relayClientId, msg);
  }

  private subscribeClientStatus(client: VirtualClient): void {
    if (!this.onStatusSubscribe) return;

    client.statusUnsubscribe = this.onStatusSubscribe(
      client.device.sessionId,
      (status: ServerStatusMessage) => {
        this.sendToRelay(client.relayClientId, status);
      }
    );
  }
}
