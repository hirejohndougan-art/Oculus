// Test-only server: the configured server plus routes that echo what they got.
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { readOculusCookie, setOculusCookie, OCULUS_COOKIES } from "./cookies.js";
import { buildServer, type ServerOptions } from "./server.js";

/** Headers that pass the Origin check under `inject` (its Host is localhost:80). */
export const SAME_ORIGIN = { origin: "http://localhost" } as const;

export interface HandlerCalls {
  count: number;
}

/** A server with echo routes; `calls.count` counts handler runs. */
export async function testServer(
  options: Omit<ServerOptions, "routes"> = {},
  extraRoutes?: (app: FastifyInstance) => void,
): Promise<{ app: FastifyInstance; calls: HandlerCalls }> {
  const calls: HandlerCalls = { count: 0 };
  const app = await buildServer({
    env: {},
    ...options,
    routes: (r) => {
      r.post("/echo", (request) => {
        calls.count++;
        return { body: request.body ?? null };
      });
      r.post("/accept", () => {
        calls.count++;
        return { ok: true };
      });
      r.post("/form", { config: { oculus: { form: true } } }, (request) => {
        calls.count++;
        return { body: request.body ?? null };
      });
      r.post("/sign-in", { config: { oculus: { form: true, credentials: true } } }, (request) => {
        calls.count++;
        return { body: request.body ?? null };
      });
      r.post(
        "/sign-in-greedy",
        { bodyLimit: 10 * 1024 * 1024, config: { oculus: { credentials: true } } },
        (request) => {
          calls.count++;
          return { body: request.body ?? null };
        },
      );
      r.get("/items/:id", (request) => {
        calls.count++;
        return { params: request.params };
      });
      r.get("/files/*", (request) => {
        calls.count++;
        return { params: request.params };
      });
      r.get("/whoami", (request) => {
        calls.count++;
        return {
          ip: request.ip,
          host: request.host,
          protocol: request.protocol,
          session: readOculusCookie(request, OCULUS_COOKIES.session) ?? null,
          cookies: (request as unknown as { cookies: unknown }).cookies,
        };
      });
      r.post("/session", (_request, reply) => {
        calls.count++;
        setOculusCookie(reply, OCULUS_COOKIES.session, "abcDEF123_-", { maxAgeSeconds: 3600 });
        return { ok: true };
      });
      extraRoutes?.(r);
    },
  });
  return { app, calls };
}

/**
 * Sends one raw HTTP/1.1 request over a real socket (127.0.0.1, a free port)
 * and returns the status code and body. `inject` can't be used for path
 * attacks: it resolves `..`, `%2e` and backslashes before the server sees them.
 */
export async function rawRequest(
  app: FastifyInstance,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<{ status: number; body: string }> {
  if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const lines = [`${method} ${target} HTTP/1.1`, "Host: localhost", "Connection: close"];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  if (body !== "") lines.push(`Content-Length: ${String(Buffer.byteLength(body))}`);
  const text = lines.join("\r\n") + "\r\n\r\n" + body;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", reject);
    socket.write(text, "latin1");
  });
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? "0");
  return { status, body: response.slice(response.indexOf("\r\n\r\n") + 4) };
}
