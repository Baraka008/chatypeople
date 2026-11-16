const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "messages.json");
const SCHEMA_FILE = path.join(ROOT, "db", "schema.sql");
const ROOM = { id: "lounge", type: "room", name: "The Lounge", members: [] };

function connectionString() {
  const value = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'Neon connection is missing. Run "neon env pull" or set DATABASE_URL_UNPOOLED in .env.local.',
    );
  }
  if (!process.env.DATABASE_URL_UNPOOLED) {
    console.warn("DATABASE_URL_UNPOOLED is missing; using DATABASE_URL for this import.");
  }
  const url = new URL(value);
  if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

async function pushData() {
  const source = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  if (!Array.isArray(source.messages) || !Array.isArray(source.users)) {
    throw new Error("messages.json must contain users and messages arrays.");
  }

  const users = new Map(
    source.users
      .filter((user) => typeof user.id === "string" && user.id.length > 0)
      .map((user) => [user.id, user]),
  );
  for (const message of source.messages) {
    if (typeof message.clientId === "string" && !users.has(message.clientId)) {
      users.set(message.clientId, { id: message.clientId, name: message.sender });
    }
  }
  for (const user of users.values()) {
    if (typeof user.name !== "string" || !user.name.trim()) {
      throw new Error(`User ${user.id} has no display name; fix it before migration.`);
    }
  }

  const conversations = new Map([[ROOM.id, ROOM]]);
  for (const conversation of source.conversations || []) {
    if (typeof conversation.id === "string" && conversation.id.length > 0) {
      conversations.set(conversation.id, conversation);
    }
  }
  const checkedMessages = source.messages.map((message) => {
    const id = Number(message.id);
    const sender = typeof message.sender === "string" ? message.sender.trim().slice(0, 32) : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const createdAt = new Date(message.createdAt);
    const conversationId = typeof message.conversationId === "string" ? message.conversationId : ROOM.id;
    if (!Number.isSafeInteger(id) || id < 1 || !users.has(message.clientId) || !conversations.has(conversationId) || !sender || !text || text.length > 2000) {
      throw new Error(`Message ${message.id} is invalid; correct the local history before migration.`);
    }
    if (Number.isNaN(createdAt.getTime())) throw new Error(`Message ${id} has an invalid timestamp.`);
    return { ...message, id, sender, text, conversationId, createdAt: createdAt.toISOString() };
  });

  const pool = new Pool({ connectionString: connectionString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await fs.readFile(SCHEMA_FILE, "utf8"));

    for (const user of users.values()) {
      await client.query(
        `INSERT INTO chat_users (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
        [user.id, user.name.trim().slice(0, 32)],
      );
    }

    for (const conversation of conversations.values()) {
      const type = ["room", "dm", "group"].includes(conversation.type) ? conversation.type : "room";
      const name = typeof conversation.name === "string" ? conversation.name.slice(0, 40) : null;
      const members = Array.isArray(conversation.members)
        ? [...new Set(conversation.members.filter((id) => typeof id === "string" && users.has(id)))]
        : [];
      await client.query(
        `INSERT INTO chat_conversations (id, type, name, members)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [conversation.id, type, name, JSON.stringify(members)],
      );
    }

    let imported = 0;
    for (const message of checkedMessages) {
      const result = await client.query(
        `INSERT INTO chat_messages (id, conversation_id, client_id, sender, text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [message.id, message.conversationId, message.clientId, message.sender, message.text, message.createdAt],
      );
      imported += result.rowCount;
    }

    await client.query(
      `SELECT setval(
        pg_get_serial_sequence('chat_messages', 'id'),
        COALESCE(MAX(id), 1),
        MAX(id) IS NOT NULL
      ) FROM chat_messages`,
    );
    await client.query("COMMIT");
    console.log(`Neon migration complete: ${users.size} users, ${conversations.size} conversations, ${imported} new messages imported.`);
    console.log("The import is safe to rerun: existing users, conversations, and message IDs are not duplicated.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

pushData().catch((error) => {
  const safeMessage = error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]");
  console.error(`Neon migration failed: ${safeMessage}`);
  process.exitCode = 1;
});
