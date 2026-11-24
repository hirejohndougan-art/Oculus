import { describe, expect, it } from "vitest";
import {
  INITIAL_WORKFLOW_STATE,
  WORKFLOW_ACTIONS,
  WORKFLOW_STATES,
  applyWorkflowAction,
  changesPublicOutput,
  isPublicState,
  isWorkflowAction,
  isWorkflowState,
  workflowActionLabel,
  workflowMoves,
  workflowStateLabel,
  workflowTransition,
  type Validated,
  type WorkflowAction,
  type WorkflowState,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

// The whole allowed table from D-075, written out independently of the module.
const ALLOWED: readonly (readonly [WorkflowState, WorkflowAction, WorkflowState])[] = [
  ["draft", "submit_for_review", "ready_for_review"],
  ["draft", "publish", "published"],
  ["ready_for_review", "return_to_draft", "draft"],
  ["ready_for_review", "publish", "published"],
  ["published", "withdraw", "withdrawn"],
  ["withdrawn", "publish", "published"],
  ["withdrawn", "return_to_draft", "draft"],
  ["withdrawn", "submit_for_review", "ready_for_review"],
];

describe("workflow states", () => {
  it("are the four states of the mockup, new records starting as draft", () => {
    expect([...WORKFLOW_STATES]).toEqual(["draft", "ready_for_review", "published", "withdrawn"]);
    expect(INITIAL_WORKFLOW_STATE).toBe("draft");
    expect(Object.isFrozen(WORKFLOW_STATES)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_ACTIONS)).toBe(true);
  });

  it("have labels for people", () => {
    expect(WORKFLOW_STATES.map(workflowStateLabel)).toEqual([
      "Draft",
      "Ready for review",
      "Published",
      "Withdrawn",
    ]);
    expect(workflowActionLabel("withdraw")).toBe("Unpublish");
    expect(workflowActionLabel("publish")).toBe("Publish");
    for (const bad of [
      "toString",
      "__proto__",
      "constructor",
      "archived",
      null,
      new String("draft"),
    ]) {
      expect(workflowStateLabel(bad)).toBe("Unknown state");
      expect(workflowActionLabel(bad)).toBe("Unknown action");
    }
  });

  it("are matched exactly", () => {
    for (const s of WORKFLOW_STATES) expect(isWorkflowState(s)).toBe(true);
    for (const bad of [
      "Draft",
      " draft",
      "draft ",
      "PUBLISHED",
      "ready for review",
      "",
      "toString",
      "__proto__",
      "constructor",
      null,
      undefined,
      0,
      true,
      ["draft"],
      { state: "draft" },
      new String("draft"),
    ]) {
      expect(isWorkflowState(bad)).toBe(false);
    }
    for (const a of WORKFLOW_ACTIONS) expect(isWorkflowAction(a)).toBe(true);
    for (const bad of ["Publish", "unpublish", "hasOwnProperty", "", null, new String("publish")]) {
      expect(isWorkflowAction(bad)).toBe(false);
    }
  });

  it("are public only when published, and never when unknown", () => {
    expect(WORKFLOW_STATES.filter(isPublicState)).toEqual(["published"]);
    for (const bad of ["Published", " published", new String("published"), null, true, 1]) {
      expect(isPublicState(bad)).toBe(false);
    }
  });
});

describe("workflowTransition", () => {
  it("allows exactly the table's moves and names their action", () => {
    for (const from of WORKFLOW_STATES) {
      for (const to of WORKFLOW_STATES) {
        const result = workflowTransition(from, to);
        const allowed = ALLOWED.find(([f, , t]) => f === from && t === to);
        if (from === to) {
          expect(codes(result)).toEqual(["no_change"]);
        } else if (allowed === undefined) {
          expect(codes(result)).toEqual(["transition_not_allowed"]);
        } else {
          expect(result).toEqual({ ok: true, value: { action: allowed[1], from, to } });
          if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
        }
      }
    }
  });

  it("takes a published record off the public only by withdrawing it", () => {
    for (const to of ["draft", "ready_for_review"] as const) {
      const result = workflowTransition("published", to);
      expect(codes(result)).toEqual(["transition_not_allowed"]);
      expect(result.ok ? "" : result.issues[0]?.message).toContain("unpublished");
    }
    expect(workflowTransition("published", "withdrawn")).toEqual({
      ok: true,
      value: { action: "withdraw", from: "published", to: "withdrawn" },
    });
  });

  it("refuses anything that isn't a state, with fixed text that never quotes it", () => {
    const secret = "<script>alert(1)</script>";
    const result = workflowTransition(secret, "Published");
    expect(codes(result)).toEqual(["invalid_state", "invalid_state"]);
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([["from"], ["to"]]);
    expect(JSON.stringify(result)).not.toContain("script");
    expect(JSON.stringify(result)).not.toContain("Published");
    expect(codes(workflowTransition("draft", undefined))).toEqual(["invalid_state"]);
    expect(codes(workflowTransition({ toString: () => "draft" }, "published"))).toEqual([
      "invalid_state",
    ]);
  });
});

describe("applyWorkflowAction", () => {
  it("leads each allowed action to its state, and refuses every other", () => {
    for (const from of WORKFLOW_STATES) {
      for (const action of WORKFLOW_ACTIONS) {
        const result = applyWorkflowAction(from, action);
        const allowed = ALLOWED.find(([f, a]) => f === from && a === action);
        if (allowed === undefined) {
          expect(codes(result)).toEqual(["action_not_allowed"]);
        } else {
          expect(result).toEqual({ ok: true, value: { action, from, to: allowed[2] } });
        }
      }
    }
  });

  it("says so when publishing a published record", () => {
    const result = applyWorkflowAction("published", "publish");
    expect(result.ok ? "" : result.issues[0]?.message).toBe("The record is already published.");
  });

  it("refuses unknown states and actions with fixed text", () => {
    expect(codes(applyWorkflowAction("archived", "delete"))).toEqual([
      "invalid_state",
      "invalid_action",
    ]);
    expect(JSON.stringify(applyWorkflowAction("archived", "delete"))).not.toMatch(
      /archived|delete/,
    );
    expect(codes(applyWorkflowAction("draft", "__proto__"))).toEqual(["invalid_action"]);
    expect(codes(applyWorkflowAction("constructor", "publish"))).toEqual(["invalid_state"]);
  });
});

describe("workflowMoves and changesPublicOutput", () => {
  it("list the buttons for each state, and none for an unknown one", () => {
    for (const from of WORKFLOW_STATES) {
      expect(workflowMoves(from).map((m) => [from, m.action, m.to])).toEqual(
        ALLOWED.filter(([f]) => f === from),
      );
      expect(Object.isFrozen(workflowMoves(from))).toBe(true);
    }
    expect(workflowMoves("toString")).toEqual([]);
    expect(workflowMoves(undefined)).toEqual([]);
  });

  it("mark publish and withdraw, the two that need the publish permission", () => {
    expect(WORKFLOW_ACTIONS.filter(changesPublicOutput)).toEqual(["publish", "withdraw"]);
  });

  it("can't be changed by a caller", () => {
    const moves = workflowMoves("draft") as unknown as { action: string }[];
    expect(() => {
      moves.push({ action: "withdraw" });
    }).toThrow(TypeError);
    expect(() => {
      (moves[0] as { action: string }).action = "withdraw";
    }).toThrow(TypeError);
    expect(workflowMoves("draft").map((m) => m.action)).toEqual(["submit_for_review", "publish"]);
  });
});
