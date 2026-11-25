/**
 * Unsaved changes and signing out (T-062, D-098). The editors register
 * whether they hold unsaved changes, so the idle warning can say they will
 * be lost; nothing of them is kept anywhere (no storage), because the next
 * person at this screen mustn't find them. While the session is ending, the
 * editors' "Leave without saving?" blockers let the way to the sign-in
 * screen through.
 */
import { useEffect } from "react";

const dirty = new Set<symbol>();
let ending = false;

/** Registers an editor's unsaved changes while `isDirty`. */
export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return undefined;
    const key = Symbol("unsaved");
    dirty.add(key);
    return () => {
      dirty.delete(key);
    };
  }, [isDirty]);
}

/** Whether any editor on screen has unsaved changes. */
export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}

/** Whether the session is ending, so leaving an editor mustn't be blocked. */
export function isSessionEnding(): boolean {
  return ending;
}

/** Marks the session as ending (true) until the sign-in screen is reached (false). */
export function setSessionEnding(value: boolean): void {
  ending = value;
}
