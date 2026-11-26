# Build sprint, then review (John, 2026-11-25)

John's instructions (2026-11-25 18:01 CT): from Monday 2026-11-30, 2:00 AM Central, several chats divide up the remaining tasks and build them at the same time. **Stage 1 is building and pushing only.** Review, merging, bug checks and security checks are **Stage 2**, which starts only once everything is built.

While this file says the sprint is in force, its rules **override** AUTOPILOT.md where they differ (one task per run, deps all `[x]`, merging after each task). All of AUTOPILOT.md's "Rules that never change" still apply: never force-push or rewrite `main`, never weaken the gate, no secrets or private data (the repo is public), no copyleft code, no code from John's private repos, never touch a live site or server, never deploy, never decide a `(needs John)` item.

**Status: IN FORCE. Stage 1 (build).** The first run that finds Stage 1 finished changes this line to "Stage 2 (review), started <date time>" and pushes.

## Who works

- **Build workers W1 to W5**: five scheduled chats that start Monday 2:00–2:16 AM and keep going, task after task, until no work is left or their session ends.
- **The every-2-hours build run** ("build run" below): one unit of work per run, picking up whatever the workers left.
- **Manual chats** John opens (Chat AC and later letters) follow the same rules and name themselves in claims.

Each worker uses its own name (W1 … W5, "build run", or the chat letter) in every claim and note.

## Stage 1: build and push

**Which tasks count.** Every `[ ]` task in ROADMAP.md, and every `[~]` task with no live claim, except:
- `(needs John)` items, and anything waiting on John's answer (S-059 until Q-13 is answered; S-040b);
- T-051 (deploy) and U-009 (a gate run on main, done in Stage 2);
- tasks waiting on outside releases (U-004, T-001b): check once; build only if their condition is now met;
- **T-067's public use**: build it, but no deed template goes public until John approves one.

Lines already marked "BUILT, NOT MERGED", "BUILT, NOT REVIEWED" or "BUILT, NOT PUSHED" on main or on the project's work board count as built. Their branches are listed at the end of this file.

**Dependencies.** A task is ready when each of its deps is either `[x]` on main **or built on a pushed `autopilot/` branch**. If a dep is only on a branch, start your branch from that branch (merge the dep branches together first if there are several) and write the base in your claim, e.g. "base: autopilot/T-066".

**Claim it on main** (as the work board describes):
1. `git pull` main. Check the line is still `[ ]` (or a stale `[~]`, see below).
2. Change the line to: `- [~] … Building (W2, 2026-11-30 02:10 CT): branch autopilot/<id>; base: <main or branch>. Sprint: build only.`
3. Reserve any migration, decision (D-), task (T-/S-/U-) or server-rule numbers you will need in "Reserved numbers" below, in the **same commit**: always above main's highest and above every reservation listed.
4. Commit "Claim <id> (W2)" and push. If the push is rejected, pull, re-check, and pick another task if it was taken.

**Big tasks.** Split a task too big for a few hours (T-080, T-084, T-088, T-058, T-069 and others) into `a`, `b`, `c` parts in ROADMAP.md in the claim commit, claim the first part, and leave the rest `[ ]` for other workers.

**Build.**
- Work on `autopilot/<id>`. Small commits. Every feature ships with tests; every fix with a test that fails without it; follow `design/DESIGN.md` for anything a person sees. Log hard-to-change choices as DECISIONS entries on your branch.
- **Push your branch after every meaningful step**, so nothing is lost if the session ends.
- Before calling it built, run the tests for the packages you changed, `npm run typecheck`, and lint and Prettier on the changed files. The full gate is optional in Stage 1.
- **Do not merge code into main. Do not run the independent review.** Don't mark `[x]`, and don't change `PROGRESS.md`'s past entries or `gate-baseline.json`.
- Use your own `TMPDIR` and `OCULUS_E2E_PORT`; never point a test at a real `OCULUS_FILES_DIR`; stop only processes you started.

**When it's built**, change the line on main to:
`- [~] … BUILT, NOT REVIEWED (W2, <date time>): branch autopilot/<id>, last commit <sha>; base: <…>; tests run: <…>. For the reviewer: <what is risky and what to check>.`
Add a short PROGRESS.md entry at the top (session = your name, Result: built, not reviewed), commit "Built <id> (W2)", push main, and take the next task.

**Stale claims.** A `Building (…)` claim older than 6 hours whose branch has had no push for 6 hours is abandoned. Take it over from its branch (or fresh if there's none) by changing the name and time in the claim.

**Questions.** Nobody is watching. Make the best guess, record it in a decision entry, and list anything John must look at in your PROGRESS entry.

**Stage 1 is finished** when no task above is `[ ]` and ready, and no `Building (…)` claim is live. The run that sees this changes the status line at the top to Stage 2 and pushes. A worker that finds no ready task while others are still building may wait for them only if its session allows; otherwise it stops.

## Stage 2: review, bug check, security check, merge

Take built branches **one at a time**, in dependency order (a branch before anything built on top of it). For each:

1. **Claim the review** on its ROADMAP line: `Reviewing (W3, <date time>)`. Commit "Review claim <id> (W3)" and push main; on rejection pull and pick another.
2. Pull main and merge it into `integrate-<id>`. **Renumber** the branch's migrations and decision entries above main's highest if needed, and fix every reference.
3. **Independent review:** start a separate subagent that has not seen the work, give it only `git diff main...integrate-<id>`, the task line and AUTOPILOT.md step i's instruction. For branches whose notes say they had reviews before, still review what changed since.
4. **Bug check:** read the change and its least-tested paths for wrong results, crashes, broken edge cases, data loss, concurrency problems and accessibility failures in anything a person sees. Write a test that fails for each real bug, then fix it.
5. **Security check:** check the change against OWASP ASVS and the plan's Security risk: auth and permission checks, input handling, escaping, file paths, outbound requests, tokens, and above all private data reaching public output. Each real hole gets a test that tries the attack, then the fix.
6. Fix every real finding. Re-run the review once if the fixes were substantial. File anything you can't fix as a roadmap task (it is built in Stage 2 like any other, then reviewed).
7. Run `npm ci` and the **full gate**. It must pass.
8. Mark the task `[x]` with a "Done" note, add a PROGRESS entry, raise `gate-baseline.json` (never lower it), and `git merge --ff-only` into main and push. If main moved, go back to step 2. Never force.

**When every built branch is merged:**
- Run U-009 (the full gate on main).
- A whole-project **bug sweep** and **security sweep**: `npm audit`, a secret scan of the tree and the sprint's commits, GitHub's Dependabot and code-scanning alerts (if reachable), and a review of everything merged in the sprint, especially the public pages. Fix the findings the same way (one branch each, reviewed, gated, merged).
- Write `docs/reports/<date>-sprint.md`: it starts with the progress summary (AUTOPILOT.md), then what merged, what was fixed, what's left, and every item that needs John (Q-13, S-040b, T-051, approving a deed template).
- Change the status line at the top to "ENDED <date>". After that, the normal AUTOPILOT.md rules apply again.

## Reserved numbers

Add yours in your claim commit; release unused ones when you finish. Before the sprint (from the work board, 2026-11-25): main ends at **migration 0058** and **D-117**; reserved on branches: migrations 0054 (Chat AC, T-073; must move above 0058), 0057 (T-041a), 0059 (S-054d), 0065 (S-066), 0066 (S-065), 0067 (T-059b), 0068 (S-061), 0070 (T-018b); decisions D-109 (T-070/T-071), D-110 (T-059a), D-116 (S-061), D-118 (T-018b), D-119 (Chat AC, if needed), D-120 (T-059b), D-121 (T-041a), D-122 (S-065), D-123 (T-034f); tasks up to T-088 (Phase 4), S-071, U-009, Q-13 used. **Next free: migration 0071, D-124, T-089, S-072, U-010, Q-14.**

| Number | Reserved by | For |
|---|---|---|

## Branches already built before the sprint (waiting for Stage 2)

From the project's work board, 2026-11-25 evening (check each line's notes on main or the board for what the reviewer should look at):

| Task | Branch | Last commit | State |
|---|---|---|---|
| S-061 | autopilot/S-061 | c8441d9 | built, not merged (migration 0068) |
| S-063 | autopilot/S-063 (integrate-S-063) | c3d2ca7 | reviewed twice, gate passed before the rule |
| S-060a, b, c | autopilot/S-060a, -b, -c | 04add48 / 70eed1a, 7d6d6b7, e483e36 | reviewed before the rule; merge all three together |
| S-065 | autopilot/S-065 | 253f7b8 | one review before the rule |
| T-034f | autopilot/T-034f | ad7dc87 | built, not merged (D-123) |
| S-043b | autopilot/S-043b | f9010cb | two reviews before the rule |
| S-056 | autopilot/S-056 | 3e98adf | built, not merged |
| S-054d | autopilot/S-054d | af8717d | built, not reviewed (risky) |
| S-066 | autopilot/S-066 | cdc5b59 | built, not merged |
| S-070 | autopilot/S-070 | 6230ec3 | built, not reviewed (risky) |
| T-070 | autopilot/T-070 | 9a9e075 | reviewed before the rule |
| T-071 | autopilot/T-071 | 63cda9c | on top of T-070; reviewed before the rule |
| T-047a | autopilot/T-047 | 1d966e4 | reviewed before the rule |
| T-041a | autopilot/T-041a | 5eec9d4 | reviewed before the rule; renumber migration 0057 |
| T-059a | autopilot/T-059a | d975fdf | built, not reviewed since last fixes |
| T-059b | autopilot/T-059b | c88745a | on top of T-059a; last fix not reviewed |
| T-018b + T-018a + S-013 | autopilot/T-018b | 394a71a | last must-fix not reviewed again |
| T-074a | autopilot/T-074 | aa7d49e | two reviews before the rule |
| T-073 | autopilot/T-073 | (Chat AC; pushed only if it was told to) | in progress on 2026-11-25 |
