import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {URL} from "node:url";
import {WebSocketServer, WebSocket} from "ws";
import {createAppConfig} from "../core/config.ts";
import type {AppConfig} from "../core/types.ts";
import type {GatewayRequestEnvelope, GatewayResponseEnvelope} from "./protocol.ts";
import {GatewayRuntime, type GatewayAgentFactory} from "./runtime.ts";

export class GatewayServer {
  readonly config: AppConfig;
  private readonly server: Server;
  private readonly wsServer: WebSocketServer;
  private readonly runtime: GatewayRuntime;

  constructor(config = createAppConfig(), createAgent?: GatewayAgentFactory) {
    this.config = config;
    this.runtime = new GatewayRuntime(config, createAgent);
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.wsServer = new WebSocketServer({ server: this.server });
    this.wsServer.on("connection", (socket: WebSocket) => {
      this.handleSocket(socket);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.gateway.port, this.config.gateway.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((wsError?: Error) => {
        if (wsError) {
          reject(wsError);
          return;
        }
        this.server.close((httpError) => {
          if (httpError) {
            reject(httpError);
            return;
          }
          resolve();
        });
      });
    });
  }

  async waitUntilClosed(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.once("close", () => resolve());
    });
  }

  getOrigin(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      return `http://${this.config.gateway.host}:${this.config.gateway.port}`;
    }
    return `http://${address.address}:${address.port}`;
  }

  getWsOrigin(): string {
    return this.getOrigin().replace(/^http/, "ws");
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(`${JSON.stringify({ ok: true, name: "BinaClaw Gateway", ws: this.getWsOrigin() })}\n`);
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify({ error: "Not found" })}\n`);
  }

  private handleSocket(socket: WebSocket): void {
    socket.on("message", (raw: WebSocket.RawData) => {
      void this.handleSocketMessage(socket, raw.toString());
    });
  }

  private async handleSocketMessage(socket: WebSocket, raw: string): Promise<void> {
    let envelope: GatewayRequestEnvelope;
    try {
      envelope = JSON.parse(raw) as GatewayRequestEnvelope;
    } catch {
      this.send(socket, {
        kind: "response",
        requestId: "unknown",
        type: "health",
        ok: false,
        error: "Invalid JSON payload",
      } satisfies GatewayResponseEnvelope);
      return;
    }

    try {
      const payload = await this.runtime.handleRequest(envelope, {
        emit: (event) => this.send(socket, event),
      });
      this.send(socket, {
        kind: "response",
        requestId: envelope.requestId,
        type: envelope.type,
        ok: true,
        payload,
      } satisfies GatewayResponseEnvelope);
    } catch (error) {
      this.send(socket, {
        kind: "response",
        requestId: envelope.requestId,
        type: envelope.type,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies GatewayResponseEnvelope);
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }
}

export async function runGatewayServer(config = createAppConfig()): Promise<void> {
  const server = new GatewayServer(config);
  await server.listen();
  console.log(`BinaClaw Gateway listening on ${server.getWsOrigin()}`);

  const close = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });

  await server.waitUntilClosed();
}
