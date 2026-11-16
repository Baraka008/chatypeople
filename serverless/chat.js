const { attachDatabasePool } = require("@vercel/functions");
const { Pool } = require("pg");
const { createHash, randomUUID } = require("node:crypto");

const ROOM = { id: "lounge", type: "room", name: "The Lounge", members: [] };
const MAX_GROUP_MEMBERS = 32;
let pool;
let schemaReady;

function database() {
  if (!process.env.DATABASE_URL) {
    throw invalid(503, "DATABASE_URL is not configured. Connect a Neon database to this Vercel project.");
  }
  if (!pool) {
    pool = new Pool({ connectionString: secureConnectionString(process.env.DATABASE_URL), max: 5 });
    if (process.env.VERCEL) attachDatabasePool(pool);
  }
  return pool;
}

function secureConnectionString(value) {
  const url = new URL(value);
  if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = database()
      .query(`
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS chat_messages_conversation_id_id_idx
          ON chat_messages (conversation_id, id);
        INSERT INTO chat_conversations (id, type, name, members)
        VALUES ('lounge', 'room', 'The Lounge', '[]'::jsonb)
        ON CONFLICT (id) DO NOTHING;
      `)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  await schemaReady;
}

function send(response, status, value) {
  response.status(status).json(value);
}

function bodyOf(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch {
      return null;
    }
  }
  return null;
}

function memberList(value) {
  return Array.isArray(value) ? value : [];
}

function failure(response, error) {
  if (error.statusCode) {
    send(response, error.statusCode, { error: error.message });
    return;
  }
  console.error(error);
  send(response, 500, { error: "The hosted chat could not complete the request. Check the Vercel function logs." });
}

function requireMethod(request, response, method) {
  if (request.method === method) return true;
  response.setHeader("Allow", method);
  send(response, 405, { error: `Use ${method} for this endpoint.` });
  return false;
}

function invalid(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function queryValue(request, key) {
  const value = request.query?.[key];
  return Array.isArray(value) ? value[0] : value || "";
}

async function handleProfile(request, response) {
  if (!requireMethod(request, response, "POST")) return;
  const body = bodyOf(request);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (id.length < 1 || id.length > 64 || name.length < 1 || name.length > 32) {
    throw invalid(400, "A device ID and a name between 1 and 32 characters are required.");
  }
  const { rows } = await database().query(
    `INSERT INTO chat_users (id, name)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
     RETURNING id, name`,
    [id, name],
  );
  send(response, 200, { user: rows[0] });
}

async function handleUsers(request, response) {
  if (!requireMethod(request, response, "GET")) return;
  const clientId = queryValue(request, "clientId");
  const query = queryValue(request, "q").trim();
  const { rows: users } = await database().query(
    `SELECT id, name
     FROM chat_users
     WHERE id <> $1 AND name ILIKE $2
     ORDER BY name
     LIMIT 40`,
    [clientId, `%${query}%`],
  );
  send(response, 200, { users });
}

async function handleConversations(request, response) {
  if (request.method === "GET") {
    const clientId = queryValue(request, "clientId");
    const { rows } = await database().query(
      `SELECT c.id, c.type, c.name, c.members, c.created_at,
         latest.text AS latest_text, latest.sender AS latest_sender, latest.created_at AS latest_created_at
       FROM chat_conversations c
       LEFT JOIN LATERAL (
         SELECT text, sender, created_at
         FROM chat_messages
         WHERE conversation_id = c.id
         ORDER BY id DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE c.type = 'room' OR c.members @> $1::jsonb`,
      [JSON.stringify([clientId])],
    );
    const memberIds = [...new Set(rows.flatMap((row) => memberList(row.members)))];
    const { rows: allUsers } = await database().query(
      "SELECT id, name FROM chat_users WHERE id = ANY($1::text[])",
      [memberIds],
    );
    const usersById = new Map(allUsers.map((user) => [user.id, user]));
    const conversations = rows.map((row) => {
      const members = memberList(row.members);
      const otherUsers = members.filter((id) => id !== clientId).map((id) => usersById.get(id)).filter(Boolean);
      const latestMessage = row.latest_text === null
        ? null
        : { text: row.latest_text, sender: row.latest_sender, createdAt: row.latest_created_at };
      return {
        id: row.id,
        type: row.type,
        name: row.name,
        members: members.map((id) => usersById.get(id)).filter(Boolean),
        displayName: row.type === "dm" ? (otherUsers[0]?.name || "Unknown person") : row.name,
        subtitle: row.type === "dm"
          ? "Direct message"
          : row.type === "group"
            ? `${members.length} members`
            : "A shared place to chat",
        latestMessage,
        updatedAt: latestMessage?.createdAt || row.created_at,
      };
    }).sort((a, b) => {
      if (a.id === ROOM.id) return -1;
      if (b.id === ROOM.id) return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    send(response, 200, { conversations });
    return;
  }

  if (!requireMethod(request, response, "POST")) return;
  const body = bodyOf(request);
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const pool = database();
  const creator = await pool.query("SELECT id FROM chat_users WHERE id = $1", [clientId]);
  if (!creator.rowCount) throw invalid(401, "Set your profile before creating a conversation.");

  const type = body?.type;
  if (type !== "dm" && type !== "group") throw invalid(400, "Choose a direct message or group conversation.");
  const requestedIds = Array.isArray(body.memberIds)
    ? [...new Set(body.memberIds.filter((id) => typeof id === "string" && id !== clientId))]
    : [];
  if (requestedIds.length < 1 || requestedIds.length > MAX_GROUP_MEMBERS - 1) {
    throw invalid(400, `Choose between 1 and ${MAX_GROUP_MEMBERS - 1} other people.`);
  }
  const foundUsers = await pool.query("SELECT id FROM chat_users WHERE id = ANY($1::text[])", [requestedIds]);
  const foundIds = new Set(foundUsers.rows.map((user) => user.id));
  if (requestedIds.some((id) => !foundIds.has(id))) {
    throw invalid(400, "One or more selected people are no longer available.");
  }
  const members = [clientId, ...requestedIds];

  if (type === "dm") {
    if (requestedIds.length !== 1) throw invalid(400, "A direct message can only have one other person.");
    const sortedIds = [...members].sort();
    const id = `dm-${createHash("sha256").update(JSON.stringify(sortedIds)).digest("hex")}`;
    await pool.query(
      `INSERT INTO chat_conversations (id, type, members)
       VALUES ($1, 'dm', $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, JSON.stringify(sortedIds)],
    );
    send(response, 200, { conversation: await getConversation(pool, id, clientId) });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 40) throw invalid(400, "Group names must be between 2 and 40 characters.");
  const id = `group-${randomUUID()}`;
  await pool.query(
    "INSERT INTO chat_conversations (id, type, name, members) VALUES ($1, 'group', $2, $3::jsonb)",
    [id, name, JSON.stringify(members)],
  );
  send(response, 201, { conversation: await getConversation(pool, id, clientId) });
}

async function getConversation(pool, id, clientId) {
  const { rows } = await pool.query(
    "SELECT id, type, name, members, created_at FROM chat_conversations WHERE id = $1",
    [id],
  );
  const row = rows[0];
  const members = memberList(row.members);
  const { rows: allUsers } = await pool.query(
    "SELECT id, name FROM chat_users WHERE id = ANY($1::text[])",
    [members],
  );
  const usersById = new Map(allUsers.map((user) => [user.id, user]));
  const otherUsers = members.filter((memberId) => memberId !== clientId).map((memberId) => usersById.get(memberId)).filter(Boolean);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    members: members.map((memberId) => usersById.get(memberId)).filter(Boolean),
    displayName: row.type === "dm" ? (otherUsers[0]?.name || "Unknown person") : row.name,
    subtitle: row.type === "dm" ? "Direct message" : row.type === "group" ? `${members.length} members` : "A shared place to chat",
    latestMessage: null,
    updatedAt: row.created_at,
  };
}

async function handleMessages(request, response) {
  const conversationId = queryValue(request, "id");
  const pool = database();
  const { rows: conversations } = await pool.query(
    "SELECT id, type, members FROM chat_conversations WHERE id = $1",
    [conversationId],
  );
  const conversation = conversations[0];

  if (request.method === "GET") {
    if (!conversation) throw invalid(404, "Conversation not found.");
    const clientId = queryValue(request, "clientId");
    if (conversation.type !== "room" && !memberList(conversation.members).includes(clientId)) {
      throw invalid(404, "Conversation not found.");
    }
    const afterValue = queryValue(request, "after") || "0";
    const after = Number(afterValue);
    if (!Number.isSafeInteger(after) || after < 0) throw invalid(400, "The message cursor must be a non-negative integer.");
    const { rows: messages } = await pool.query(
      `SELECT id, conversation_id AS "conversationId", client_id AS "clientId", sender, text, created_at AS "createdAt"
       FROM chat_messages
       WHERE conversation_id = $1 AND id > $2
       ORDER BY id
       LIMIT 1000`,
      [conversationId, after],
    );
    send(response, 200, { messages });
    return;
  }

  if (!requireMethod(request, response, "POST")) return;
  if (!conversation) throw invalid(404, "Conversation not found.");
  const body = bodyOf(request);
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (conversation.type !== "room" && !memberList(conversation.members).includes(clientId)) {
    throw invalid(404, "Conversation not found.");
  }
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const { rows: users } = await pool.query("SELECT name FROM chat_users WHERE id = $1", [clientId]);
  if (!users[0] || users[0].name !== sender) throw invalid(401, "Your profile is out of date. Refresh and try again.");
  if (text.length < 1 || text.length > 2000) throw invalid(400, "Messages must be between 1 and 2,000 characters.");

  const { rows: [message] } = await pool.query(
    `INSERT INTO chat_messages (conversation_id, client_id, sender, text)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id AS "conversationId", client_id AS "clientId", sender, text, created_at AS "createdAt"`,
    [conversationId, clientId, sender, text],
  );
  send(response, 201, { message });
}

function run(handler) {
  return async (request, response) => {
    try {
      await ensureSchema();
      await handler(request, response);
    } catch (error) {
      failure(response, error);
    }
  };
}

module.exports = {
  profile: run(handleProfile),
  users: run(handleUsers),
  conversations: run(handleConversations),
  messages: run(handleMessages),
};
