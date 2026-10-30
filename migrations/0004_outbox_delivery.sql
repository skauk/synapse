-- What actually happened to each message: "simulated", "sent: <id>", "redirected: <id>", "not sent: <reason>", "failed: <error>".
ALTER TABLE outbox ADD COLUMN delivery TEXT NOT NULL DEFAULT 'simulated';
