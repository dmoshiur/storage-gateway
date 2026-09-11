-- Keep the organization-wide retention policy in the dedicated rules table as
-- well as the settings document used by the dashboard. The application updates
-- both records together when the default retention changes.
CREATE UNIQUE INDEX IF NOT EXISTS retention_rules_name_unique ON retention_rules (lower(name));

INSERT INTO retention_rules(name, enabled, retention_type, days)
VALUES ('default', true, '6_months', 180)
ON CONFLICT DO NOTHING;
