CREATE TABLE IF NOT EXISTS chat_users (
  id TEXT PRIMARY KEY,
  name VARCHAR(32) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('room', 'dm', 'group')),
  name VARCHAR(40),
  members JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES chat_users(id),
  sender VARCHAR(32) NOT NULL,
  text VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_id_id_idx
  ON chat_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  keys JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO chat_conversations (id, type, name, members)
VALUES ('lounge', 'room', 'The Lounge', '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;
