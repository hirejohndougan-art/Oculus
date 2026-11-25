// Upload routes in the HTTP layer (M-002, D-086), with no database: which
// routes may be upload routes, the type list both ways, the view handed to
// the handler (bytes once, never the stream), the cap counted as bytes
// arrive with chunked encoding, and `Connection: close` when the body isn't
// read to its end.
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { UPLOAD_TYPES } from "./body.js";
import { MAX_UPLOAD_BYTES, checkRoute, type OculusRoute } from "./routes.js";
import { SAME_ORIGIN, testServer } from "./test-server.fixtures.js";

const noop = () => ({ ok: true });

describe("which routes may take uploads", () => {
  it("refuses a bad cap, a GET, a form or credentials upload route and extra options", () => {
    const bad: unknown[] = [
      { method: "POST", path: "/u", upload: { maxBytes: 0 }, handler: noop },
      { method: "POST", path: "/u", upload: { maxBytes: 1.5 }, handler: noop },
      { method: "POST", path: "/u", upload: { maxBytes: MAX_UPLOAD_BYTES + 1 }, handler: noop },
      { method: "POST", path: "/u", upload: { maxBytes: "10" }, handler: noop },
      { method: "POST", path: "/u", upload: { maxBytes: 10, types: ["text/html"] }, handler: noop },
      { method: "POST", path: "/u", upload: true, handler: noop },
      { method: "GET", path: "/u", upload: { maxBytes: 10 }, handler: noop },
      { method: "DELETE", path: "/u", upload: { maxBytes: 10 }, handler: noop },
      { method: "POST", path: "/u", form: true, upload: { maxBytes: 10 }, handler: noop },
      { method: "POST", path: "/u", credentials: true, upload: { maxBytes: 10 }, handler: noop },
      {
        method: "POST",
        path: "/u",
        upload: {
          get maxBytes() {
            return 10;
          },
        },
        handler: noop,
      },
    ];
    for (const route of bad) expect(() => checkRoute(route), JSON.stringify(route)).toThrow();
    expect(
      checkRoute({ method: "PUT", path: "/u", upload: { maxBytes: 10 }, handler: noop }).upload,
    ).toEqual({
      maxBytes: 10,
    });
  });

  it("has no active type on its list", () => {
    for (const type of UPLOAD_TYPES) {
      expect(type).not.toMatch(/html|xml|svg|javascript|ecmascript|xsl|multipart|message/);
    }
  });
});

interface Seen {
  calls: number;
  views: unknown[];
  bytes: number[];
  errors: string[];
}

async function uploadServer(
  maxBytes: number,
  readAll = true,
): Promise<{ app: FastifyInstance; seen: Seen }> {
  const seen: Seen = { calls: 0, views: [], bytes: [], errors: [] };
  const route: OculusRoute = {
    method: "POST",
    path: "/upload",
    upload: { maxBytes },
    handler: async (request) => {
      seen.calls++;
      const upload = request.upload;
      seen.views.push(upload === undefined ? null : Object.keys(upload).sort());
      if (upload === undefined) return { got: null };
      if (!readAll) return { read: 0 };
      let total = 0;
      for await (const chunk of upload.chunks()) total += chunk.byteLength;
      try {
        upload.chunks();
      } catch (error) {
        seen.errors.push((error as Error).message);
      }
      seen.bytes.push(total);
      return { total, type: upload.contentType, declared: upload.declaredBytes ?? null };
    },
  };
  const { app } = await testServer({}, [route]);
  return { app, seen };
}

/**
 * One keep-alive request over a real socket; `parts` are written one by one
 * (chunked unless `length` is set). Resolves with the reply even if the
 * server stops reading early.
 */
async function post(
  app: FastifyInstance,
  parts: string[],
  length?: number,
): Promise<{ status: number; connection: string | undefined; body: string }> {
  if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/upload",
        agent: false,
        headers: {
          host: "localhost",
          origin: "http://localhost",
          connection: "keep-alive",
          "content-type": "application/octet-stream",
          ...(length === undefined ? {} : { "content-length": String(length) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (error) => {
      setTimeout(() => {
        reject(error);
      }, 500);
    });
    void (async () => {
      for (const part of parts) {
        if (req.destroyed) return;
        req.write(part);
        await new Promise((r) => setTimeout(r, 5));
      }
      req.end();
    })();
  });
}

describe("the upload view", () => {
  it("gives the handler the bytes once, the type and the declared length, and no stream", async () => {
    const { app, seen } = await uploadServer(100);
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      headers: { ...SAME_ORIGIN, "content-type": "Image/PNG" },
      payload: Buffer.from("0123456789"),
    });
    expect(res.json()).toEqual({ total: 10, type: "image/png", declared: 10 });
    expect(seen.views[0]).toEqual(["chunks", "contentType", "declaredBytes"]);
    expect(seen.errors).toEqual(["an upload's bytes can be read once"]);
    await app.close();
  });

  it("refuses other types on the upload route and upload types elsewhere", async () => {
    const { app, seen } = await uploadServer(100);
    for (const type of [
      "application/json",
      "text/html",
      "image/png; x=1",
      "application/x-www-form-urlencoded",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/upload",
        headers: { ...SAME_ORIGIN, "content-type": type },
        payload: type === "application/json" ? "{}" : "a=b",
      });
      expect(res.statusCode, type).toBe(415);
    }
    const elsewhere = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { ...SAME_ORIGIN, "content-type": "application/octet-stream" },
      payload: "bytes",
    });
    expect(elsewhere.statusCode).toBe(415);
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it("counts chunked bytes as they arrive and answers 413 with the connection closed", async () => {
    const { app, seen } = await uploadServer(25);
    const res = await post(app, ["0123456789", "0123456789", "0123456789", "0123456789"]);
    expect(res.status).toBe(413);
    expect(res.body).toBe('{"error":"payload_too_large"}');
    expect(res.connection).toBe("close");
    expect(seen.bytes).toEqual([]);
    const fits = await post(app, ["0123456789", "0123456789", "01234"]);
    expect(fits.status).toBe(200);
    expect(fits.connection).toBe("keep-alive");
    expect(JSON.parse(fits.body)).toEqual({
      total: 25,
      type: "application/octet-stream",
      declared: null,
    });
    await app.close();
  });

  it("closes the connection when the handler answers without reading the body", async () => {
    const { app } = await uploadServer(100, false);
    const res = await post(app, ["unread body"], 11);
    expect(res.status).toBe(200);
    expect(res.connection).toBe("close");
    await app.close();
  });
});
