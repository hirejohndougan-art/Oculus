// Password hashing and new-password rules (passwords.ts, D-052, D-068). All
// passwords here are invented.
import { scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_HASHES,
  MAX_PASSWORD_BYTES,
  MAX_QUEUED_HASHES,
  MAX_SCRYPT_WORK,
  MIN_PASSWORD_LENGTH,
  PasswordWorkBusyError,
  SCRYPT_SETTINGS,
  checkNewPassword,
  dummyPasswordHash,
  hashPassword,
  isCommonPassword,
  isPasswordHash,
  passwordContextWords,
  passwordHashNeedsRehash,
  passwordText,
  passwordWorkCount,
  verifyPassword,
} from "./passwords.js";
import { COMMON_PASSWORDS_TEXT } from "./common-passwords.js";

const PHC = /^\$scrypt\$ln=14,r=8,p=5\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

function codes(result: ReturnType<typeof checkNewPassword>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

/** A PHC string made directly with node's scrypt and other settings. */
function oldStyleHash(password: string, ln: number, r: number, p: number): Promise<string> {
  const salt = Buffer.alloc(16, 7);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 2 ** ln, r, p, maxmem: 256 * 2 ** ln * r }, (error, key) => {
      if (error) reject(error);
      else {
        const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
        resolve(`$scrypt$ln=${String(ln)},r=${String(r)},p=${String(p)}$${b64(salt)}$${b64(key)}`);
      }
    });
  });
}

describe("hashPassword and verifyPassword", () => {
  it("stores a PHC string with today's settings and a fresh salt", async () => {
    const a = await hashPassword("a long invented passphrase");
    const b = await hashPassword("a long invented passphrase");
    expect(a).toMatch(PHC);
    expect(b).toMatch(PHC);
    expect(a).not.toBe(b);
    expect(isPasswordHash(a)).toBe(true);
    expect(passwordHashNeedsRehash(a)).toBe(false);
    expect(SCRYPT_SETTINGS).toEqual({ ln: 14, r: 8, p: 5 });
  });

  it("accepts the right password and refuses others, compared exactly as typed", async () => {
    const stored = await hashPassword("Bayou Lantern 1897");
    expect(await verifyPassword("Bayou Lantern 1897", stored)).toEqual({
      ok: true,
      needsRehash: false,
    });
    for (const wrong of [
      "bayou lantern 1897",
      "Bayou Lantern 1897 ",
      " Bayou Lantern 1897",
      "Bayou Lantern 189",
      "",
    ]) {
      expect((await verifyPassword(wrong, stored)).ok).toBe(false);
    }
  });

  it("treats composed and decomposed forms as the same password (NFC)", async () => {
    const composed = "caf\u00e9 au lait at noon";
    const decomposed = "cafe\u0301 au lait at noon";
    for (const [made, typed] of [
      [composed, decomposed],
      [decomposed, composed],
    ] as const) {
      const stored = await hashPassword(made);
      expect((await verifyPassword(typed, stored)).ok).toBe(true);
    }
    expect(passwordText(decomposed)).toBe(composed);
    // NFC, not NFKC: a full-width letter stays a different password.
    const stored = await hashPassword("plain ascii passphrase");
    expect((await verifyPassword("plain ascii passphras\uff45", stored)).ok).toBe(false);
  });

  it("refuses text with a lone surrogate", async () => {
    await dummyPasswordHash();
    const stored = await hashPassword("a password before the test");
    for (const broken of ["half \ud800 pair", "\udc00 low first", "ends high \udbff"]) {
      expect(passwordText(broken)).toBeUndefined();
      await expect(hashPassword(broken)).rejects.toThrow(TypeError);
      const before = passwordWorkCount();
      expect((await verifyPassword(broken, stored)).ok).toBe(false);
      expect(passwordWorkCount() - before).toBe(1);
    }
    expect(passwordText("an emoji \u{1F600} pair")).toBe("an emoji \u{1F600} pair");
  });

  it("runs one scrypt computation at today's cost for every check, usable or not", async () => {
    await dummyPasswordHash();
    const stored = await hashPassword("one two three four five");
    const cases: [unknown, string | undefined][] = [
      ["one two three four five", stored],
      ["wrong password here", stored],
      ["anything at all", undefined],
      ["anything at all", "$scrypt$ln=14,r=8,p=5$short$short"],
      ["anything at all", "plain text"],
      ["x".repeat(MAX_PASSWORD_BYTES + 1), stored],
      [12345678, stored],
      [undefined, stored],
    ];
    for (const [password, hash] of cases) {
      const before = passwordWorkCount();
      await verifyPassword(password, hash);
      expect(passwordWorkCount() - before).toBe(1);
    }
  });

  it("refuses an unknown user, a damaged hash and an over-long password", async () => {
    const stored = await hashPassword("x".repeat(MAX_PASSWORD_BYTES));
    expect((await verifyPassword("x".repeat(MAX_PASSWORD_BYTES), stored)).ok).toBe(true);
    expect((await verifyPassword("x".repeat(MAX_PASSWORD_BYTES + 1), stored)).ok).toBe(false);
    expect((await verifyPassword("whatever it is", undefined)).ok).toBe(false);
    expect((await verifyPassword("whatever it is", stored.slice(0, -1))).ok).toBe(false);
    // The dummy hash itself never matches what it was made from: nobody knows it.
    expect((await verifyPassword("", await dummyPasswordHash())).ok).toBe(false);
  });

  it("pads a failed check against a cheaper stored hash to today's cost", async () => {
    await dummyPasswordHash();
    const old = await oldStyleHash("an older stored password", 12, 8, 1);
    const current = await hashPassword("an older stored password");
    let before = passwordWorkCount();
    expect((await verifyPassword("not the older password", old)).ok).toBe(false);
    expect(passwordWorkCount() - before).toBe(2);
    before = passwordWorkCount();
    expect((await verifyPassword("an older stored password", old)).ok).toBe(true);
    expect(passwordWorkCount() - before).toBe(1);
    const time = async (stored: string): Promise<number> => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await verifyPassword("not the older password", stored);
        runs.push(performance.now() - t);
      }
      return runs.sort((x, y) => x - y)[2] ?? 0;
    };
    const ratio = (await time(old)) / (await time(current));
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(2);
  }, 60_000);

  it("says when a correct password's hash has old settings", async () => {
    const old = await oldStyleHash("an older stored password", 12, 8, 1);
    expect(isPasswordHash(old)).toBe(true);
    expect(passwordHashNeedsRehash(old)).toBe(true);
    expect(await verifyPassword("an older stored password", old)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(await verifyPassword("not the older password", old)).toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it("refuses stored settings that would cost too much memory or time", async () => {
    const salt = "A".repeat(22);
    const key = "A".repeat(43);
    for (const settings of [
      "ln=21,r=8,p=1",
      "ln=9,r=8,p=1",
      "ln=20,r=32,p=1",
      "ln=14,r=8,p=17",
      // N must be below 2^(16·r) (RFC 7914), or scrypt itself throws.
      "ln=16,r=1,p=1",
      // More work than MAX_SCRYPT_WORK (2^16·8·5 > 2^21), though memory is fine.
      "ln=16,r=8,p=5",
    ]) {
      const stored = `$scrypt$${settings}$${salt}$${key}`;
      expect(isPasswordHash(stored)).toBe(false);
      const before = passwordWorkCount();
      expect((await verifyPassword("anything", stored)).ok).toBe(false);
      expect(passwordWorkCount() - before).toBe(1);
    }
    expect(isPasswordHash(`$scrypt$ln=15,r=1,p=1$${salt}$${key}`)).toBe(true);
    expect(isPasswordHash(`$scrypt$ln=16,r=8,p=2$${salt}$${key}`)).toBe(true);
    expect(MAX_SCRYPT_WORK).toBe(2 ** 21);
    expect(isPasswordHash(`$argon2id$v=19$m=19456,t=2,p=1$${salt}$${key}`)).toBe(false);
  });

  it("refuses to hash what isn't a password", async () => {
    await expect(hashPassword("x".repeat(MAX_PASSWORD_BYTES + 1))).rejects.toThrow(RangeError);
    // 512 two-byte characters are 1,024 bytes: allowed; one more is not.
    await expect(hashPassword("é".repeat(512))).resolves.toMatch(PHC);
    await expect(hashPassword("é".repeat(513))).rejects.toThrow(RangeError);
    await expect(hashPassword(42 as unknown as string)).rejects.toThrow(TypeError);
  });

  it("refuses work beyond the queue instead of growing without bound", async () => {
    const total = MAX_CONCURRENT_HASHES + MAX_QUEUED_HASHES + 5;
    const results = await Promise.allSettled(
      Array.from({ length: total }, () => hashPassword("queued password test")),
    );
    const busy = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof PasswordWorkBusyError,
    );
    expect(busy).toHaveLength(5);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(total - 5);
    // Afterwards the slots are free again.
    await expect(hashPassword("after the burst")).resolves.toMatch(PHC);
  }, 60_000);
});

describe("checkNewPassword", () => {
  it("counts characters, not bytes or UTF-16 units, for the minimum", () => {
    expect(codes(checkNewPassword("a".repeat(MIN_PASSWORD_LENGTH - 1)))).toEqual(["too_short"]);
    expect(codes(checkNewPassword("qzv7#kfw"))).toEqual([]);
    // Seven emoji are 14 UTF-16 units but 7 characters.
    expect(codes(checkNewPassword("\u{1F600}".repeat(7)))).toEqual(["too_short"]);
    expect(codes(checkNewPassword("\u{1F600}".repeat(8)))).toEqual([]);
  });

  it("allows up to 1,024 bytes, without composition rules", () => {
    expect(codes(checkNewPassword("lowercase only words here"))).toEqual([]);
    expect(codes(checkNewPassword("é".repeat(512)))).toEqual([]);
    expect(codes(checkNewPassword("é".repeat(513)))).toEqual(["too_long"]);
  });

  it("returns the password as given apart from NFC, and measures the NFC form", () => {
    const r = checkNewPassword("  spaces kept at both ends  ");
    expect(r).toEqual({ ok: true, value: "  spaces kept at both ends  " });
    expect(checkNewPassword("cafe\u0301 au lait at noon")).toEqual({
      ok: true,
      value: "caf\u00e9 au lait at noon",
    });
    // Eight code points decomposed, four once composed.
    expect(codes(checkNewPassword("e\u0301".repeat(4)))).toEqual(["too_short"]);
    expect(codes(checkNewPassword("broken \ud800 password"))).toEqual(["invalid_text"]);
  });

  it("refuses common passwords whatever their case", () => {
    expect(isCommonPassword("password1")).toBe(true);
    expect(codes(checkNewPassword("password1"))).toEqual(["common_password"]);
    expect(codes(checkNewPassword("PASSWORD1"))).toEqual(["common_password"]);
    expect(codes(checkNewPassword("qwertyuiop"))).toEqual(["common_password"]);
    const list = COMMON_PASSWORDS_TEXT.split("\n").filter((l) => l !== "");
    expect(list.length).toBeGreaterThan(2000);
    expect(list.every((l) => l.length >= MIN_PASSWORD_LENGTH && l === l.toLowerCase())).toBe(true);
  });

  it("refuses passwords that are mostly context words, and allows passphrases using one", () => {
    expect(codes(checkNewPassword("Dickinson2026"))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("oculusoculus!"))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("HistoricalSociety1"))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("we walked along dickinson bayou at dusk"))).toEqual([]);
    const context = {
      email: "pat.example@example.org",
      displayName: "Pat Example",
      organizationName: "Riverbend Heritage Trust",
    };
    expect(codes(checkNewPassword("Riverbend!!42", context))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("PatExample99", context))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("heritage-trust-7", context))).toEqual(["context_words"]);
    expect(codes(checkNewPassword("Riverbend!!42"))).toEqual([]);
    expect(passwordContextWords(context)).toEqual(
      expect.arrayContaining(["oculus", "example", "riverbend", "heritage", "trust"]),
    );
    // Words under 4 letters are not context words ("pat", "org").
    expect(passwordContextWords(context)).not.toContain("pat");
    expect(passwordContextWords(context)).not.toContain("org");
  });

  it("refuses what isn't text, and never repeats the password in a message", () => {
    expect(codes(checkNewPassword(12345678))).toEqual(["not_text"]);
    expect(codes(checkNewPassword(undefined))).toEqual(["not_text"]);
    for (const p of ["short", "password1", "Dickinson2026", "é".repeat(600)]) {
      const r = checkNewPassword(p);
      expect(r.ok).toBe(false);
      if (!r.ok) for (const i of r.issues) expect(i.message).not.toContain(p);
    }
  });
});
