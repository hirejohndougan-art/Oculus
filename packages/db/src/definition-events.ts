/**
 * Definitions made or changed, in the change log (S-064, D-117): identifier
 * types, terms, sites, the storage levels and locations, Dublin Core
 * mappings and the System settings. Migration 0051's triggers write every
 * row, in the change's own transaction, naming the transaction's
 * `oculus.actor` (the service sets it, service.ts `run`) or the account the
 * changed row names. Nothing here writes; the audit trail reads the table
 * (people.ts `readAuditTrail`).
 */

/** Exactly what the writer may do: add rows, through the triggers (roles.ts). */
export const DEFINITION_EVENT_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    definition_events: Object.freeze(["INSERT"]),
  });
