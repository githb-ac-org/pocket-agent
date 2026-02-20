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
  private authTokens: Map<string, { deviceId: string; deviceName: string; relayClientId?: string }> = new Map();
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
      const devices: Array<{ token: string; deviceId: string; deviceName: string }> = JSON.parse(raw);
      for (const d of devices) {
        this.authTokens.set(d.token, { deviceId: d.deviceId, deviceName: d.deviceName });
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
      case 'ping':
        this.sendToRelay(client.relayClientId, { type: 'pong' });
        break;
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
