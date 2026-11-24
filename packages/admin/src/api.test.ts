// @vitest-environment jsdom
// The fetch wrapper (D-073): CSRF on changes only, If-Match and the working
// site, errors as ApiError, the CSRF token picked up from replies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, currentCsrfToken, problemText, setCsrfToken, waitText } from "./api";
import { fakeServer } from "./testing.fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api()", () => {
  it("sends the CSRF token on changes, never on reads, with If-Match and the site", async () => {
    const sent = fakeServer({
      "GET /api/me": [200, { csrfToken: "a".repeat(43) }],
      "PUT /api/records/x": [200, { ok: true }],
    });
    await api("/api/me");
    expect(sent[0]?.headers["x-oculus-csrf"]).toBeUndefined();
    expect(currentCsrfToken()).toBe("a".repeat(43));
    await api("/api/records/x", { method: "PUT", body: {}, ifMatch: 3, site: "s1" });
    expect(sent[1]?.headers).toMatchObject({
      "x-oculus-csrf": "a".repeat(43),
      "if-match": '"v3"',
      "x-oculus-site": "s1",
      "content-type": "application/json",
    });
  });

  it("takes a new token from a reply's session, and forgets it on request", async () => {
    fakeServer({ "POST /api/organization": [200, { session: { csrfToken: "b".repeat(43) } }] });
    await api("/api/organization", { body: {} });
    expect(currentCsrfToken()).toBe("b".repeat(43));
    setCsrfToken(null);
    expect(currentCsrfToken()).toBeUndefined();
  });

  it("turns an error reply into an ApiError with its code and body", async () => {
    fakeServer({ "POST /api/sign-in": [429, { error: "throttled", retryAfterSeconds: 30 }] });
    const error = await api("/api/sign-in", { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "throttled" });
    expect(problemText(error)).toBe("Too many tries. Wait 30 seconds and try again.");
  });

  it("refuses paths outside /api/ and reports a network failure", async () => {
    await expect(api("https://example.org/api/x")).rejects.toThrow(/\/api\//);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    await expect(api("/api/me")).rejects.toMatchObject({ code: "network_error" });
  });

  it("words waits plainly", () => {
    expect(waitText(5)).toBe("5 seconds");
    expect(waitText(61)).toBe("about 2 minutes");
    expect(waitText(60)).toBe("about a minute");
  });
});
