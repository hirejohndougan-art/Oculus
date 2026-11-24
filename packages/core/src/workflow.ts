/**
 * Workflow states: where a record is on its way to the public (T-034a,
 * decision D-075).
 *
 * Every record is in exactly one of four states, as in the mockup's Items
 * list and record editor:
 *
 * | State | Label | Public? |
 * |---|---|---|
 * | `draft` | Draft | no |
 * | `ready_for_review` | Ready for review | no |
 * | `published` | Published | yes |
 * | `withdrawn` | Withdrawn | no |
 *
 * A new record starts as `draft`. Only `published` is public
 * (`isPublicState`); every other state, and anything that isn't a state at
 * all, is treated as not public. Saving, restoring an old version (D-065)
 * and changing identifiers never change the state: only the four actions
 * below do.
 *
 * **Actions.** A state changes only by one of these, and only along these
 * moves (`workflowTransition`):
 *
 * | Action | From | To |
 * |---|---|---|
 * | `submit_for_review` | draft, withdrawn | ready_for_review |
 * | `return_to_draft` | ready_for_review, withdrawn | draft |
 * | `publish` | draft, ready_for_review, withdrawn | published |
 * | `withdraw` | published | withdrawn |
 *
 * A published record leaves the public only by `withdraw`, never straight
 * back to draft or review, so taking something off the public sites is
 * always the one action that needs the publish permission (D-036). Both
 * actions that change what the public sees, `publish` and `withdraw`, are
 * marked by `changesPublicOutput`; the service checks the publish
 * permission for them (T-041) and the other two need only the permission to
 * edit the record. Publishing from `draft` is allowed because the approval
 * step is optional and off by default (T-035, a future feature); when it is
 * on, it narrows `publish` to records that are `ready_for_review`.
 *
 * This module is pure: it says which moves exist. Whether a record may be
 * published right now (`effectivePublishIssues`, the deed check and the
 * access restrictions at that moment) is the service's check when it
 * publishes (T-034b), and who may act is T-041's.
 *
 * Input is untrusted: states are matched exactly (no trimming, no case
 * folding), anything else is `invalid_state`, and messages are fixed text
 * that never quote the input.
 */
import { issue, type Issue, type Validated } from "./issues.js";

/** Every workflow state, in the order a record usually moves through them. */
export const WORKFLOW_STATES = Object.freeze([
  "draft",
  "ready_for_review",
  "published",
  "withdrawn",
] as const);

/** Where a record is on its way to the public. */
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Every workflow action. */
export const WORKFLOW_ACTIONS = Object.freeze([
  "submit_for_review",
  "return_to_draft",
  "publish",
  "withdraw",
] as const);

/** One of the four ways a record's state changes. */
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/** The state every new record starts in. */
export const INITIAL_WORKFLOW_STATE: WorkflowState = "draft";

/** One allowed move: the action, and the state it leads to. */
export interface WorkflowMove {
  readonly action: WorkflowAction;
  readonly to: WorkflowState;
}

/** A checked change of state. */
export interface WorkflowTransition {
  readonly action: WorkflowAction;
  readonly from: WorkflowState;
  readonly to: WorkflowState;
}

const LABELS: Readonly<Record<WorkflowState, string>> = Object.freeze({
  draft: "Draft",
  ready_for_review: "Ready for review",
  published: "Published",
  withdrawn: "Withdrawn",
});

const ACTION_LABELS: Readonly<Record<WorkflowAction, string>> = Object.freeze({
  submit_for_review: "Send for review",
  return_to_draft: "Return to draft",
  publish: "Publish",
  withdraw: "Unpublish",
});

function move(action: WorkflowAction, to: WorkflowState): WorkflowMove {
  return Object.freeze({ action, to });
}

// The whole table of allowed moves, from each state. Nothing else is allowed.
const MOVES: Readonly<Record<WorkflowState, readonly WorkflowMove[]>> = Object.freeze({
  draft: Object.freeze([
    move("submit_for_review", "ready_for_review"),
    move("publish", "published"),
  ]),
  ready_for_review: Object.freeze([move("return_to_draft", "draft"), move("publish", "published")]),
  published: Object.freeze([move("withdraw", "withdrawn")]),
  withdrawn: Object.freeze([
    move("publish", "published"),
    move("return_to_draft", "draft"),
    move("submit_for_review", "ready_for_review"),
  ]),
});

/** True only for one of the four state names, written exactly. */
export function isWorkflowState(value: unknown): value is WorkflowState {
  return (
    typeof value === "string" &&
    (value === "draft" ||
      value === "ready_for_review" ||
      value === "published" ||
      value === "withdrawn")
  );
}

/** True only for one of the four action names, written exactly. */
export function isWorkflowAction(value: unknown): value is WorkflowAction {
  return (
    typeof value === "string" &&
    (value === "submit_for_review" ||
      value === "return_to_draft" ||
      value === "publish" ||
      value === "withdraw")
  );
}

/**
 * True only for `published`. Anything else, including a value that isn't a
 * state, is not public: the public side never treats an unknown state as
 * published.
 */
export function isPublicState(value: unknown): boolean {
  return value === "published";
}

/** The state's label for people ("Ready for review"); "Unknown state" for anything that isn't a state. */
export function workflowStateLabel(state: unknown): string {
  return isWorkflowState(state) ? LABELS[state] : "Unknown state";
}

/**
 * The action's label for a button ("Unpublish" for `withdraw`, as in
 * DESIGN.md); "Unknown action" for anything that isn't an action.
 */
export function workflowActionLabel(action: unknown): string {
  return isWorkflowAction(action) ? ACTION_LABELS[action] : "Unknown action";
}

/**
 * True for the actions that change what the public sees (`publish` and
 * `withdraw`): they need the publish permission (D-036, checked by T-041),
 * and `publish` runs the publish checks at that moment (T-034b).
 */
export function changesPublicOutput(action: WorkflowAction): boolean {
  return action === "publish" || action === "withdraw";
}

/** The moves allowed from a state, for showing the right buttons. Empty for anything that isn't a state. */
export function workflowMoves(from: unknown): readonly WorkflowMove[] {
  return isWorkflowState(from) ? MOVES[from] : [];
}

/**
 * Check a change of state from untrusted input: both must be states, they
 * must differ, and the move must be one of the allowed ones. Returns the
 * action that makes it, or every problem found.
 */
export function workflowTransition(from: unknown, to: unknown): Validated<WorkflowTransition> {
  const issues: Issue[] = [];
  if (!isWorkflowState(from)) {
    issues.push(issue(["from"], "invalid_state", "The current state is not a workflow state."));
  }
  if (!isWorkflowState(to)) {
    issues.push(issue(["to"], "invalid_state", "The new state is not a workflow state."));
  }
  if (!isWorkflowState(from) || !isWorkflowState(to)) return { ok: false, issues };
  if (from === to) {
    return {
      ok: false,
      issues: [issue(["to"], "no_change", "The record is already in this state.")],
    };
  }
  const found = MOVES[from].find((m) => m.to === to);
  if (found === undefined) {
    return {
      ok: false,
      issues: [
        issue(
          ["to"],
          "transition_not_allowed",
          from === "published"
            ? "A published record must be unpublished (withdrawn) before it can move to another state."
            : "A record can't move straight from this state to that one.",
        ),
      ],
    };
  }
  return { ok: true, value: Object.freeze({ action: found.action, from, to }) };
}

/**
 * Check an action asked for on a record in a given state: where does it
 * lead? Refuses anything that isn't a state or an action
 * (`invalid_state`, `invalid_action`) and an action not allowed from that
 * state (`action_not_allowed`), for example publishing a record that is
 * already published.
 */
export function applyWorkflowAction(from: unknown, action: unknown): Validated<WorkflowTransition> {
  const issues: Issue[] = [];
  if (!isWorkflowState(from)) {
    issues.push(issue(["from"], "invalid_state", "The current state is not a workflow state."));
  }
  if (!isWorkflowAction(action)) {
    issues.push(issue(["action"], "invalid_action", "This is not a workflow action."));
  }
  if (!isWorkflowState(from) || !isWorkflowAction(action)) return { ok: false, issues };
  const found = MOVES[from].find((m) => m.action === action);
  if (found === undefined) {
    return {
      ok: false,
      issues: [
        issue(
          ["action"],
          "action_not_allowed",
          action === "publish" && from === "published"
            ? "The record is already published."
            : "This action can't be taken on a record in this state.",
        ),
      ],
    };
  }
  return { ok: true, value: Object.freeze({ action, from, to: found.to }) };
}
