import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CoworkerConfig } from "./config.js";
import type { Connector, ConnectorRequest } from "./types.js";

function lowerCaseHeaders(message: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(message.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value ?? ""]),
  );
}

async function readBody(message: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of message) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeResponse(response: ServerResponse, status: number, headers: Record<string, string> | undefined, body: string | Buffer): void {
  response.writeHead(status, headers);
  response.end(body);
}

export function createCoworkerServer(config: CoworkerConfig, connectors: Connector[]) {
  return createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
      if (incoming.method === "GET" && url.pathname === "/healthz") {
        writeResponse(response, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({
          ok: true,
          service: "cowoker",
          connectors: connectors.map((connector) => connector.name),
        }));
        return;
      }

      const request: ConnectorRequest = {
        method: incoming.method ?? "GET",
        pathname: url.pathname,
        query: url.searchParams,
        headers: lowerCaseHeaders(incoming),
        rawBody: await readBody(incoming, config.server.maxBodyBytes),
      };

      for (const connector of connectors) {
        const result = await connector.handle(request);
        if (!result) continue;
        writeResponse(response, result.status, result.headers, result.body);
        if (result.afterSend) setImmediate(result.afterSend);
        return;
      }

      writeResponse(response, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        writeResponse(response, 400, { "content-type": "text/plain; charset=utf-8" }, message);
      } else {
        response.end();
      }
    }
  });
}

export function listen(server: ReturnType<typeof createCoworkerServer>, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
