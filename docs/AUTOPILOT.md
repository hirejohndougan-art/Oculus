# Autopilot

Oculus is built by scheduled Claude sessions with **no human approval** (see D-003 in [DECISIONS.md](DECISIONS.md)). Three sessions run every night, each with its own job:

| Session | Time (Central) | Job |
|---|---|---|
| **build** | 12:38 am | Do the next roadmap task. |
| **upkeep** | 3:27 am | Update dependencies, make recent code faster or simpler, close test gaps, keep docs in step with the code. If none of that is needed, do the next roadmap task instead. |
| **security** | 5:51 am | Check for vulnerable dependencies, leaked secrets and security bugs in the code merged since the last security run, and fix what's found. If everything is clean, do the next roadmap task instead. |

Every session does exactly **one task**, checks its own work against the gate, merges to `main`, pushes, records what it did and stops. This file is the procedure. Follow it in order, every run.

## Files

| File | What |
|---|---|
| `docs/AUTOPILOT.md` | this procedure |
| `docs/PLATFORM_PLAN.md` | goals, decisions, architecture, phases |
| `docs/ROADMAP.md` | phases and tasks with status; the run picks its task here |
| `docs/DECISIONS.md` | decision log |
| `docs/PROGRESS.md` | one entry per run, newest at the top |
| `docs/reports/` | weekly reports (`YYYY-MM-DD.md`, written on Sundays) and monthly reviews (`YYYY-MM-review.md`) |
| `design/DESIGN.md` | the look every screen must follow |
| `gate-baseline.json` | the floor for `tests_passing` (created by task T-001) |

Task marks: `[ ]` not started · `[~]` in progress or partly done · `[x]` done · `[!]` stuck.
`(risky)` = needs an independent review (step i). `(needs John)` = blocked on a decision only John can make; never pick it, list it in the weekly report. `deps: T-002` = wait for those tasks. `attempts: N` = failed attempts so far.

## The gate

`npm run gate` must pass before anything merges. Task T-001 creates it. Once it exists it runs, in order:

1. Formatting check (Prettier)
2. Lint (ESLint, TypeScript rules)
3. Type check (`tsc --noEmit`, strict mode)
4. The full test suite (Vitest)
5. The build
6. `npm audit --audit-level=high`: no high or critical advisories
7. The license check: every dependency is MIT, BSD, ISC, Apache-2.0 or similarly permissive (see D-002)
8. **Key metric `tests_passing`** is never below `gate-baseline.json`. After a passing merge, raise the floor to the new count.

Until T-001 is merged there is no gate. T-001's run sets it up and must show it passing before it merges.

## Every run

**a. Read the state.** Run `git pull`. Read PLATFORM_PLAN.md, ROADMAP.md, the top 5 entries of PROGRESS.md and the DECISIONS.md titles (open any entry that bears on your task). Note today's date and time in America/Chicago, and which session you are: the scheduled prompt says so.

**Special runs.** The **build** session does these *instead of* a roadmap task, then goes to step k:
- **Weekly report:** on Sundays, if `docs/reports/<today>.md` doesn't exist, write it. Cover what merged this week, tasks done and stuck, the gate and `tests_passing` trend, dependency and security findings, everything marked `(needs John)` with the question he needs to answer, and next week's plan. Start it with the progress summary (below). One page.
- **Monthly review:** on the first build run on or after the 1st of a month, if `docs/reports/<YYYY-MM>-review.md` doesn't exist, check the direction against PLATFORM_PLAN.md and re-plan: add, split or remove tasks, and write the next phase's tasks. Revisit every `[!]` task: reset it with a new approach, split it, or drop it with a decision entry. Write the review file.

**b. Check main.** If the last PROGRESS entry says the gate failed, or `main` has commits after the last recorded PASS, run the gate. If it fails, **fixing main is this run's task**: it outranks everything.

**c. Pick the task.**
- **build:** the first `[ ]` or `[~]` task in the current phase whose deps are all `[x]`, skipping `[!]` and `(needs John)`. If the phase is finished, write the next phase's run-sized tasks; that writing is the run's task.
- **upkeep:** check, in this order, and do the first one that needs doing:
  1. `npm outdated`: update within the current major version; a new major gets its own roadmap task and a decision entry, not a quiet bump.
  2. Code merged in the last 7 days that is slower, longer or more tangled than it needs to be: measure before and after, and keep the change only if it's clearly better.
  3. Public functions with no tests, and tests that don't check the result.
  4. Docs (README, ROADMAP, the module headers) that no longer match the code.

  If none of these needs anything, do a build task.
- **security:** check all of these:
  - `npm audit`
  - a secret scan of the whole tree and of commits since the last security run (keys, tokens, passwords, private keys, `.env` files)
  - GitHub's security alerts (`gh api repos/hirejohndougan-art/oculus/dependabot/alerts` and `/code-scanning/alerts`, if reachable)
  - a review of every commit since the last security run, against OWASP ASVS and the "Security" risk in the plan: injection, auth and permission checks, input validation, output escaping, file paths, outbound requests, unsafe deserialization, private data reaching public output, and the separation between the admin (private) and the public sites (public)

  Fix the most serious real finding (one per run) and add the others to ROADMAP.md as `(risky)` tasks at the top of the current phase. If all is clean, write "clean" in the PROGRESS entry and do a build task.

**d. Size it.** A run has room for one focused change plus the gate. If the task is bigger (it touches more than about 3 modules, or you can't describe the finished change in two sentences), split it into `T-004a`, `T-004b` … in ROADMAP.md, mark the parent `[~]` and do the first part. Commit the split even if nothing else happens.

**e. Research.** Use primary sources: the standards themselves (EDTF from the Library of Congress, DACS from SAA, Spectrum from Collections Trust, Dublin Core from DCMI, rightsstatements.org, IIIF, OAI-PMH, EAD), the TypeScript, Node.js and PostgreSQL docs, MDN, OWASP, and CVE/NVD and GitHub advisories. Cite what you used in the commit message or the PROGRESS entry.

**f. Log decisions.** Anything hard to change later gets a DECISIONS.md entry: a data format or schema, an ID scheme, a public API shape, a security model, a new dependency, a supported Node or PostgreSQL version. The entry gives the choice, what was rejected, and why. Never decide a `(needs John)` item.

**g. Build on a branch.** `git checkout -b autopilot/<task-id>-<short-name>`. Small commits. Every feature ships with tests. Every bug fix comes with a test that fails without the fix. Every security fix comes with a test that tries the attack. Follow the code style around you, and follow `design/DESIGN.md` for anything a person will see.

**h. Run the gate.** If it fails, fix and re-run. If you can't get it to pass, this attempt failed: go to "When a task fails".

**i. Independent review for risky work.** Get one if the task is marked `(risky)`, or if the change touches any of these:
- security: auth, sessions, roles and permissions, input handling, escaping, file paths, outbound requests, crypto, tokens
- data loss: deleting, migrating or overwriting records
- the published/private boundary
- concurrency

For the review, start a **separate subagent that has not seen your work**. Give it only the diff (`git diff main...HEAD`), the task description, and this instruction: "Review this change to Oculus, a collections platform for archives and museums, for security holes, data loss, private data leaking into public output, and broken behavior. List concrete problems with file and line, or say it is safe. Do not fix anything." Fix every real problem it finds, re-run the gate, and repeat the review once if the fixes were substantial. Note the result in the PROGRESS entry.

**j. Merge and push.**
1. Run `git fetch origin main`. If main moved, rebase onto it and re-run the gate.
2. Run `git checkout main && git merge --ff-only autopilot/<branch> && git push origin main`, then delete the branch.
3. If the push is rejected, fetch, rebase, re-run the gate and try again. Never force.
4. Raise `gate-baseline.json` to the new `tests_passing`, and commit it as "autopilot: raise test baseline".

**k. Record and stop.** Set the task's status in ROADMAP.md, and add any follow-up tasks you found. Add a PROGRESS.md entry at the top (format below). Commit it as "autopilot: record <task-id>", push, then stop. One task per run.

## When a task fails

A failed attempt means the gate can't be made to pass, the review finds problems you can't fix, or the run ends before the task is done. When that happens:
- Don't merge anything broken.
- Push your branch (`autopilot/...`) so the next attempt can start from it.
- Increase `attempts: N` on the task.
- Write what you tried and where it broke in the PROGRESS entry, then stop.

At **attempts: 3**, mark the task `[!]`. Later runs skip it, and the monthly review revisits it.

## Progress summary

John asked (2026-11-21) that every progress report to him starts with this summary: the weekly report, the monthly review, and any answer to "how is it going" or "show me the progress".

- **Project complete:** done tasks ÷ all tasks, as a percentage. Count `[x]` as done, `[~]` as half done, and every other task in ROADMAP.md. Don't count the `Q-` questions.
- **Each phase:** the same percentage for every phase that has tasks. For phases with no tasks written yet, say "not planned yet".
- **Small jobs:** the same percentage for the follow-ups and fixes (`T-NNNa`-style tasks and `S-`, `U-` and `M-` tasks), counted on their own.
- **Needs a decision:** a bullet list of every `(needs John)` item and `Q-` question, each with the question in one line.
- **Estimated time to finish:** tasks left ÷ tasks done per day over the last 7 days (or since the project started, if that's shorter). Phases with no tasks yet are estimated at the average size of the phases that have them. Give the date and the number of days, and say that the estimate assumes the current pace and grows if phases turn out bigger.

## PROGRESS entry format

```
## YYYY-MM-DD HH:MM CT — <session> — <task id> <task title>
- Result: done | partial | failed (attempt N) | gate fix | clean | weekly report | monthly review
- What changed: <one or two lines; commits>
- Decisions: <D-NNN or none>
- Review: <independent review result, or n/a>
- Gate: PASS/FAIL · tests_passing <N> (was <M>) · npm audit <clean / findings>
- Next: <the task the next run should pick>
```

## Rules that never change

- **Git safety:**
  - Never force-push `main`, never rewrite its history, never delete tags.
- **Never weaken the gate:**
  - Don't remove checks or loosen lint, type or audit settings.
  - Don't lower the baseline, and don't delete or skip failing tests.
  - A test may be changed only when the test itself is wrong, and the commit says why.
- **This repository is public** (D-001):
  - No secrets of any kind, not even in tests. Test data uses obvious fakes.
  - No private data about real people: donors, researchers, volunteers, members.
  - Sample data uses invented records, or item titles already published on the Dickinson Historical Society's public archive.
- **Licensing** (D-002):
  - No code copied from John's private repositories (Polybius, Blueprint, Hestia or any other) unless a DECISIONS entry written by John allows it.
  - No code or dependencies under GPL, AGPL, LGPL or other copyleft licenses.
  - Note the source and license of anything adapted from elsewhere.
- **No AI in the product** (D-004): no hosted AI, no AI SDKs and no pretrained models inside Oculus. The only exception is OCR, which may use an engine's trained models, run locally and permissively licensed (D-033).
- **Leave real systems alone.** Never touch the live Dickinson Historical Society sites, its Omeka S archive, or any server. Oculus runs only in this sandbox until John deploys it.
- **Don't decide `(needs John)` items.** These include hosting and one or two server apps. (Whether the Society's other sites move to Oculus is answered: no, D-032.)
- One task per run. Leave `main` passing the gate.
