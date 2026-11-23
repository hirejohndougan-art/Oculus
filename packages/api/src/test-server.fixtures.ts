// Test-only server: the configured server plus routes that echo what they got.
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { ORIGINS_ENV } from "./origin.js";
import type { OculusRoute } from "./routes.js";
import { buildServer, type ServerOptions } from "./server.js";

/** Headers that pass the Origin check under `inject` (its Host is localhost:80). */
export const SAME_ORIGIN = { origin: "http://localhost" } as const;

/** The environment test servers start with. */
export const TEST_ENV = { [ORIGINS_ENV]: "http://localhost" } as const;

export interface HandlerCalls {
  count: number;
}

/** A server with echo routes; `calls.count` counts handler runs. */
export async function testServer(
  options: Omit<ServerOptions, "routes"> = {},
  extraRoutes: readonly OculusRoute[] = [],
): Promise<{ app: FastifyInstance; calls: HandlerCalls }> {
  const calls: HandlerCalls = { count: 0 };
  const echo = (request: { body: unknown }) => {
    calls.count++;
    return { body: request.body ?? null };
  };
  const routes: OculusRoute[] = [
    { method: "POST", path: "/echo", handler: echo },
    {
      method: "POST",
      path: "/accept",
      handler: () => {
        calls.count++;
        return { ok: true };
      },
    },
    { method: "POST", path: "/form", form: true, handler: echo },
    { method: "POST", path: "/sign-in", form: true, credentials: true, handler: echo },
    { method: "POST", path: "/sign-in-json", credentials: true, handler: echo },
    {
      method: "GET",
      path: "/items/:id",
      handler: (request) => {
        calls.count++;
        return { params: request.params };
      },
    },
    {
      method: "GET",
      path: "/files/*",
      handler: (request) => {
        calls.count++;
        return { params: request.params };
      },
    },
    {
      method: "GET",
      path: "/whoami",
      handler: (request) => {
        calls.count++;
        return {
          ip: request.ip,
          host: request.host,
          protocol: request.protocol,
          session: request.cookies[OCULUS_COOKIES.session] ?? null,
          cookieNames: Object.keys(request.cookies),
        };
      },
    },
    {
      method: "POST",
      path: "/session",
      handler: (_request, reply) => {
        calls.count++;
        reply.setCookie(OCULUS_COOKIES.session, "abcDEF123_-", { maxAgeSeconds: 3600 });
        return { ok: true };
      },
    },
    ...extraRoutes,
  ];
  const app = await buildServer({ ...options, env: { ...TEST_ENV, ...options.env }, routes });
  return { app, calls };
}

/**
 * Sends one raw HTTP/1.1 request over a real socket (127.0.0.1, a free port)
 * and returns the status code, the head (status line and headers) and body. `inject` can't be used for path
 * attacks: it resolves `..`, `%2e` and backslashes before the server sees them.
 */
export async function rawRequest(
  app: FastifyInstance,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<{ status: number; head: string; body: string }> {
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
  const end = response.indexOf("\r\n\r\n");
  return { status, head: response.slice(0, end), body: response.slice(end + 4) };
}
