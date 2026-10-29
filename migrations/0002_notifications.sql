-- Messages for the requesting doctor. Stands in for the Matrix room until the Matrix app service exists.
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  request_id TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  text       TEXT NOT NULL
);
