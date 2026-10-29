-- Matrix retries a transaction until it gets a 200. Events seen once are never processed again.
CREATE TABLE matrix_events (
  event_id TEXT PRIMARY KEY,
  ts       TEXT NOT NULL
);
