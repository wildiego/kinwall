-- Credentials use the family's encryption key and stay out of exports.
CREATE TABLE mealie_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL,
  last_synced_at TEXT, last_error TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease TEXT
);
CREATE TABLE mealie_meals (
  remote_id INTEGER PRIMARY KEY,
  meal_id TEXT NOT NULL UNIQUE REFERENCES meals(id) ON DELETE CASCADE
);
