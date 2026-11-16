const { attachDatabasePool } = require("@vercel/functions");
const { Pool } = require("pg");
const { createHash, randomUUID } = require("node:crypto");

const ROOM = { id: "lounge", type: "room", name: "The Lounge", members: [] };
const MAX_GROUP_MEMBERS = 32;
let pool;
let schemaReady;
let webPushPromise;

function loadWebPush() {
  if (!webPushPromise) webPushPromise = import("web-push");
  return webPushPromise;
}

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

async function handleNotifications(request, response) {
  if (request.method === "GET") {
    if (!process.env.VAPID_PUBLIC_KEY) {
      throw invalid(503, "Push notifications are not configured on this server.");
    }
    send(response, 200, { publicKey: process.env.VAPID_PUBLIC_KEY });
    return;
  }
  if (!requireMethod(request, response, "POST")) return;
  const body = bodyOf(request);
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const pool = database();
  const user = await pool.query("SELECT id FROM chat_users WHERE id = $1", [clientId]);
  if (!user.rowCount) throw invalid(401, "Set your profile before changing notification settings.");

  if (body?.action === "unsubscribe") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    await pool.query("DELETE FROM chat_push_subscriptions WHERE endpoint = $1 AND client_id = $2", [endpoint, clientId]);
    send(response, 200, { subscribed: false });
    return;
  }

  const subscription = body?.subscription;
  const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
  const keys = subscription?.keys;
  if (!endpoint.startsWith("https://") || endpoint.length > 2048
    || typeof keys?.p256dh !== "string" || keys.p256dh.length > 256
    || typeof keys?.auth !== "string" || keys.auth.length > 128) {
    throw invalid(400, "A valid browser push subscription is required.");
  }
  await pool.query(
    `INSERT INTO chat_push_subscriptions (endpoint, client_id, keys)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (endpoint) DO UPDATE
     SET client_id = EXCLUDED.client_id, keys = EXCLUDED.keys, updated_at = NOW()`,
    [endpoint, clientId, JSON.stringify(keys)],
  );
  send(response, 200, { subscribed: true });
}

async function notifyConversation(pool, conversation, message) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const webPush = await loadWebPush();
    webPush.setVapidDetails(
      process.env.VAPID_SUBJECT || "https://chatypeople.netlify.app",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  } catch (error) {
    console.error("Could not configure Web Push:", error);
    return;
  }
  const { rows } = conversation.type === "room"
    ? await pool.query(
      "SELECT endpoint, keys FROM chat_push_subscriptions WHERE client_id <> $1",
      [message.clientId],
    )
    : await pool.query(
      "SELECT endpoint, keys FROM chat_push_subscriptions WHERE client_id = ANY($1::text[]) AND client_id <> $2",
      [memberList(conversation.members), message.clientId],
    );
  const payload = JSON.stringify({
    title: `${message.sender} · ${conversation.name || "New message"}`,
    body: message.text,
    conversationId: conversation.id,
  });
  const results = await Promise.allSettled(rows.map((subscription) =>
    webPush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      payload,
      { TTL: 60 },
    ),
  ));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") continue;
    const statusCode = result.reason?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await pool.query("DELETE FROM chat_push_subscriptions WHERE endpoint = $1", [rows[index].endpoint]);
    } else {
      console.error("Could not deliver a chat notification; push service status:", statusCode || "unknown");
    }
  }
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
      `SELECT id, conversation_id AS "conversationId", client_id AS "clientId", sender, text,
         created_at AS "createdAt", edited_at AS "editedAt"
       FROM chat_messages
       WHERE conversation_id = $1 AND id > $2
       ORDER BY id
       LIMIT 1000`,
      [conversationId, after],
    );
    send(response, 200, { messages });
    return;
  }

  if (!["POST", "PATCH", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, PATCH, DELETE");
    send(response, 405, { error: "Use GET, POST, PATCH, or DELETE for this endpoint." });
    return;
  }
  if (!conversation) throw invalid(404, "Conversation not found.");
  const body = bodyOf(request);
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (conversation.type !== "room" && !memberList(conversation.members).includes(clientId)) {
    throw invalid(404, "Conversation not found.");
  }
  if (request.method === "PATCH" || request.method === "DELETE") {
    const messageId = typeof body?.messageId === "string" || typeof body?.messageId === "number"
      ? String(body.messageId)
      : "";
    if (!/^[1-9]\d*$/.test(messageId)) throw invalid(400, "A valid message ID is required.");
    if (request.method === "DELETE") {
      const { rowCount } = await pool.query(
        "DELETE FROM chat_messages WHERE id = $1 AND conversation_id = $2 AND client_id = $3",
        [messageId, conversationId, clientId],
      );
      if (!rowCount) throw invalid(404, "Message not found or you cannot delete it.");
      send(response, 200, { deleted: true });
      return;
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (text.length < 1 || text.length > 2000) throw invalid(400, "Messages must be between 1 and 2,000 characters.");
    const { rows } = await pool.query(
      `UPDATE chat_messages
       SET text = $1, edited_at = NOW()
       WHERE id = $2 AND conversation_id = $3 AND client_id = $4
       RETURNING id, conversation_id AS "conversationId", client_id AS "clientId",
         sender, text, created_at AS "createdAt", edited_at AS "editedAt"`,
      [text, messageId, conversationId, clientId],
    );
    if (!rows[0]) throw invalid(404, "Message not found or you cannot edit it.");
    send(response, 200, { message: rows[0] });
    return;
  }
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const { rows: users } = await pool.query("SELECT name FROM chat_users WHERE id = $1", [clientId]);
  if (!users[0] || users[0].name !== sender) throw invalid(401, "Your profile is out of date. Refresh and try again.");
  if (text.length < 1 || text.length > 2000) throw invalid(400, "Messages must be between 1 and 2,000 characters.");

  const { rows: [message] } = await pool.query(
    `INSERT INTO chat_messages (conversation_id, client_id, sender, text)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id AS "conversationId", client_id AS "clientId", sender, text,
       created_at AS "createdAt", edited_at AS "editedAt"`,
    [conversationId, clientId, sender, text],
  );
  try {
    await notifyConversation(pool, conversation, message);
  } catch (error) {
    console.error("Message was saved, but push notification delivery failed:", error);
  }
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
  notifications: run(handleNotifications),
};
