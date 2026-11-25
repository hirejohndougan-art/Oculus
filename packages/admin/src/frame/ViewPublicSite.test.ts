// The public home address (T-070, D-109): only a bare http(s) origin becomes
// a link, and only as `<origin>/`; anything else is "no public address".
import { describe, expect, it } from "vitest";
import { publicHomeAddress } from "./ViewPublicSite";

describe("publicHomeAddress", () => {
  it("is the bare origin with a slash", () => {
    expect(publicHomeAddress("https://archive.example.org")).toBe("https://archive.example.org/");
    expect(publicHomeAddress("http://localhost:4781")).toBe("http://localhost:4781/");
  });

  it("refuses anything that isn't a bare http(s) origin", () => {
    for (const value of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://archive.example.org/path",
      "https://archive.example.org/?token=x",
      "https://user:pw@archive.example.org",
      "https://ARCHIVE.example.org",
      "//archive.example.org",
      "archive.example.org",
    ]) {
      expect([value, publicHomeAddress(value)]).toEqual([value, undefined]);
    }
  });
});
