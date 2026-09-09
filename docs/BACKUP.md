# Backup and retention considerations

Cloudflare R2 is durable object storage, but it is **not by itself a complete NGO backup strategy**. This gateway intentionally avoids an expensive backup subsystem at its small expected scale. The NGO should still decide how it will recover from accidental administrator action, cloud-account compromise, a configuration error, or a wider operational incident.

## Recommended future-ready approach

1. **Periodic metadata export** — export non-sensitive Firestore `files` metadata and `auditLogs` to an encrypted, access-controlled location. Preserve IDs, original names, retention fields, and final object keys so an object inventory can be reconciled.
2. **Second bucket / provider copy** — copy final `pdfs/` objects to a separately permissioned R2 bucket, Cloudflare account, or another approved archival provider. Do not grant the gateway runtime token write access to the backup destination.
3. **Restore drills** — periodically choose a non-sensitive test PDF and prove the organization can restore metadata/object access using documented procedures.
4. **Retention alignment** — make backup retention consistent with legal, donor, and safeguarding requirements. A backup should not indefinitely defeat an approved deletion policy without governance approval.
5. **Encryption and access review** — use provider encryption at rest and restrict backup principals. Keep recovery keys/accounts outside a single administrator’s control.

## What not to do

- Do not call a public R2 URL a backup.
- Do not store PDF base64 or binary in Firestore exports.
- Do not put backup credentials in the Next.js frontend or repository.
- Do not silently enable a replication rule without documenting its cost, retention, and deletion implications.

Before implementing a backup worker, clarify recovery objectives, data classification, geographic/legal constraints, owner responsibility, testing cadence, and budget.
