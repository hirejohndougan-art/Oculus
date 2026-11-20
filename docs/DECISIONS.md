# Decisions

Newest at the bottom. Each entry gives the choice, what was rejected, and why.

## D-001 — Public repository (2026-11-20, John)
Oculus is developed in a public GitHub repository. Nothing private goes in it: no secrets, no private data about real people, and no code from John's private repositories (see D-002).

## D-002 — MIT license; permissive dependencies only (2026-11-20, John)
The code is MIT-licensed, so any archive, museum or historical society can use it. Dependencies must be MIT, BSD, ISC, Apache-2.0 or similarly permissive. GPL, AGPL and LGPL are not allowed, because they would change the terms for anyone installing Oculus. Code from John's private repositories (Polybius, Blueprint and others) may be brought in only by an entry here written by John.

## D-003 — Built by autopilot, no human approval (2026-11-20, John)
Three scheduled sessions each night (build, upkeep, security) do one task each, check it against the gate, and merge to `main` themselves. This is the same model as John's Blueprint, Argus and FerroJS projects. John can switch to pull requests he approves by changing step j of AUTOPILOT.md and recording it here.

## D-004 — No AI inside the product (carried over from the Polybius project)
Oculus contains no hosted AI, no AI SDKs and no pretrained models. Suggestion features use classical retrieval: BM25 plus a curated synonym list.

## D-005 — Platform name and parts (2026-11-20, John)
The platform is **Oculus**. Its staff back end is called **Polybius** and its public sites are called **Hermes**. These are names for parts of one product, not separate products.
