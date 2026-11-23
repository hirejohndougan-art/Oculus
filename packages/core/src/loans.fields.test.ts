// Valuation, insurance and authoriser fields on loans (T-018a2, D-060):
// staff-only, a valuation as a decimal string with an ISO 4217 code, never a
// float, and nothing of them quoted in a message.
import { afterEach, describe, expect, it } from "vitest";
import {
  newLoanId,
  newOrganizationId,
  newRecordId,
  publicView,
  validateLoan,
  type LoanOut,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const NOW = new Date("2026-11-23T18:00:00.000Z");

function loan(extra: Record<string, unknown> = {}): LoanOut {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "out",
    number: "LO-2026-001",
    agentId: newRecordId(),
    beginOn: "2026-09-01",
    endOn: "2026-11-15",
    status: "agreed",
    statusOn: "2026-08-15",
    items: [{ recordId: newRecordId() }],
    ...extra,
  };
}

function codes(r: Validated<unknown>): string[] {
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe("valuation, insurance and authoriser", () => {
  it("accepts them all and keeps the amount as written", () => {
    const given = loan({
      valuation: { amount: "12500.00", currency: "USD" },
      insuredBy: "borrower",
      insuranceReference: "POL-0000-FAKE",
      authorisedBy: "Collections committee chair",
      authoriserId: newRecordId(),
      authorisedOn: "2026-08-14",
    });
    const v = validateLoan(given, NOW);
    expect(codes(v)).toEqual([]);
    if (!v.ok) return;
    expect(v.value.valuation).toEqual({ amount: "12500.00", currency: "USD" });
    expect(Object.isFrozen(v.value.valuation)).toBe(true);
    expect(publicView(v.value as never)).toBeUndefined();
  });

  it("takes amounts as decimal text only: never a number, a sign, an exponent or grouping", () => {
    for (const amount of ["0", "0.5", "1", "999999999999999.9999", "120.10"]) {
      expect(codes(validateLoan(loan({ valuation: { amount, currency: "USD" } }), NOW))).toEqual(
        [],
      );
    }
    for (const amount of [
      12500,
      0.1,
      "1e5",
      "-5",
      "+5",
      "1,000",
      "1 000",
      "01",
      ".5",
      "5.",
      "1.00001",
      "1000000000000000",
      "NaN",
      "Infinity",
      "",
      "１２",
    ]) {
      expect(codes(validateLoan(loan({ valuation: { amount, currency: "USD" } }), NOW))).toEqual([
        "invalid_amount",
      ]);
    }
  });

  it("takes an ISO 4217 code, and only amount and currency", () => {
    for (const currency of ["usd", "US", "USDX", "$", 840]) {
      expect(codes(validateLoan(loan({ valuation: { amount: "1", currency } }), NOW))).toEqual([
        "invalid_currency",
      ]);
    }
    expect(codes(validateLoan(loan({ valuation: { amount: "1" } }), NOW))).toEqual([
      "invalid_currency",
    ]);
    expect(
      codes(validateLoan(loan({ valuation: { amount: "1", currency: "USD", rate: "1" } }), NOW)),
    ).toEqual(["unknown_property"]);
    expect(codes(validateLoan(loan({ valuation: "12500 USD" }), NOW))).toEqual([
      "invalid_valuation",
    ]);
  });

  it("checks insurer, reference and authoriser", () => {
    expect(codes(validateLoan(loan({ insuredBy: "nobody" }), NOW))).toEqual(["invalid_insurer"]);
    expect(codes(validateLoan(loan({ insuranceReference: "A\nB" }), NOW))).toEqual([
      "control_characters",
    ]);
    expect(codes(validateLoan(loan({ authorisedOn: "2026-08-14" }), NOW))).toEqual(["required"]);
    expect(codes(validateLoan(loan({ authoriserId: newRecordId() }), NOW))).toEqual(["required"]);
    expect(
      codes(validateLoan(loan({ authorisedBy: "Chair", authorisedOn: "2026-12-01" }), NOW)),
    ).toEqual(["future_authorisation"]);
    expect(
      codes(validateLoan(loan({ authorisedBy: "Chair", authoriserId: "chair" }), NOW)),
    ).toEqual(["invalid_id"]);
    expect(codes(validateLoan(loan({ authorisedBy: " " }), NOW))).toEqual(["invalid_text"]);
  });

  it("never quotes a valuation or a reference in a message", () => {
    const secret = "98765.4321X";
    const r = validateLoan(
      loan({
        valuation: { amount: secret, currency: "ZZ9" },
        insuranceReference: `${secret}\n`,
      }),
      NOW,
    );
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain("ZZ9");
  });

  describe("with Object.prototype polluted", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).amount;
      delete (Object.prototype as Record<string, unknown>).currency;
    });

    it("an amount or currency on the prototype doesn't complete a valuation", () => {
      (Object.prototype as Record<string, unknown>).amount = "1";
      (Object.prototype as Record<string, unknown>).currency = "USD";
      expect(codes(validateLoan(loan({ valuation: { currency: "USD" } }), NOW))).toEqual([
        "invalid_amount",
      ]);
      expect(codes(validateLoan(loan({ valuation: {} }), NOW))).toEqual([
        "invalid_amount",
        "invalid_currency",
      ]);
    });
  });
});
