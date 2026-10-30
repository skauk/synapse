-- Commands sent to the bot per Matrix user and day (Europe/Vienna), for the open demo server's limit.
CREATE TABLE bot_usage (
  user  TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user, day)
);
