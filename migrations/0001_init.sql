-- Append-only, hash-chained audit log. seq is not autoincrement: a concurrent
-- insert with the same seq fails and the writer retries with the new tail.
CREATE TABLE audit (
  seq        INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  request_id TEXT NOT NULL,
  event      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  detail     TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX audit_request ON audit (request_id, seq);

-- Simulated mail and SMS delivery (stands in for Mailpit and an SMS gateway).
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  request_id TEXT NOT NULL,
  channel    TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL
);
