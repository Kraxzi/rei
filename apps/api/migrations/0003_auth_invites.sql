-- Passkey auth: challenge payload and invite codes.
ALTER TABLE auth_challenges ADD COLUMN data TEXT;

CREATE TABLE invites (
  id TEXT PRIMARY KEY,                 -- SHA-256 of the invite code
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  note TEXT,
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id),
  used_at TEXT,
  created_at TEXT NOT NULL
);
