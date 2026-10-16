-- Users own the account credentials and are referenced by chats, messages, and notifications.
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name varchar(60) NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  email varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chats are direct conversations; direct_key prevents duplicate conversations for a user pair.
CREATE TABLE IF NOT EXISTS chats (
  id text PRIMARY KEY,
  direct_key text NOT NULL UNIQUE,
  last_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A join table models chat membership and supports permission checks.
CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, user_id)
);

-- This index speeds up finding the chats belonging to a user.
CREATE INDEX IF NOT EXISTS chat_participants_by_user
  ON chat_participants (user_id, chat_id);

-- Files live on disk; this table stores their ownership and display/download metadata.
CREATE TABLE IF NOT EXISTS media_assets (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  original_name varchar(255) NOT NULL,
  mime_type varchar(100) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_assets_by_chat ON media_assets (chat_id);

-- Messages reference both their conversation and optional uploaded media.
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text varchar(5000) NOT NULL DEFAULT '',
  attachment_id text REFERENCES media_assets(id) ON DELETE SET NULL,
  attachment_name varchar(255),
  attachment_mime_type varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(text) > 0 OR attachment_id IS NOT NULL)
);

-- Ordering by chat and time is the common message-history lookup.
CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages (chat_id, created_at);

-- Notifications are durable inbox items addressed to a recipient for a message.
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_name varchar(60) NOT NULL,
  preview varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, message_id)
);

-- These indexes support recent-notification lists and unread-only queries.
CREATE INDEX IF NOT EXISTS notifications_by_user_time
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_unread_by_user
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- New-chat notifications have no message yet, so message_id must be optional. These statements
-- are idempotent and also upgrade databases created before this change.
ALTER TABLE notifications ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message';
