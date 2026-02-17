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
  iOSStatusForwarder,
} from './types';

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
  private authTokens: Map<string, { deviceId: string; deviceName: string }> = new Map(); // persistent tokens
  private pairingCodes: Map<string, { createdAt: number }> = new Map(); // active pairing codes
  private activePairingCode: string | null = null;

  private onMessage: iOSMessageHandler | null = null;
  private onGetSessions: iOSSessionsHandler | null = null;
  private onStatusSubscribe: iOSStatusForwarder | null = null;

  constructor(port?: number) {
    this.port = port || DEFAULT_PORT;
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
   * Set handler for subscribing to agent status events
   */
  setStatusForwarder(forwarder: iOSStatusForwarder): void {
    this.onStatusSubscribe = forwarder;
  }

  /**
   * Generate a new 6-digit pairing code
   */
  generatePairingCode(): string {
    // Clear any existing code
    if (this.activePairingCode) {
      this.pairingCodes.delete(this.activePairingCode);
    }

    const code = Array.from({ length: PAIRING_CODE_LENGTH }, () =>
      Math.floor(Math.random() * 10)
    ).join('');

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

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
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

      const response: ServerResponseMessage = {
        type: 'response',
        text: result.response,
        sessionId: message.sessionId,
        tokensUsed: result.tokensUsed,
        media: result.media,
      };
      client.ws.send(JSON.stringify(response));
    } catch (error) {
      const errorMsg: ServerErrorMessage = {
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to process message',
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
