const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.CHAT_DATA_FILE || path.join(__dirname, "messages.json");
const MAX_MESSAGES = 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_GROUP_MEMBERS = 32;
const ROOM = { id: "lounge", type: "room", name: "The Lounge", members: [] };
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

let data = { users: [], conversations: [ROOM], messages: [], nextId: 1 };
let writes = Promise.resolve();

async function loadData() {
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!Array.isArray(saved.messages) || !Number.isSafeInteger(saved.nextId)) {
      throw new Error("Chat history has an invalid format.");
    }
    data = {
      users: Array.isArray(saved.users) ? saved.users : [],
      conversations: Array.isArray(saved.conversations) ? saved.conversations : [ROOM],
      messages: saved.messages.map((message) => ({
        ...message,
        conversationId: message.conversationId || ROOM.id,
      })),
      nextId: saved.nextId,
    };
    if (!data.conversations.some((conversation) => conversation.id === ROOM.id)) {
      data.conversations.unshift(ROOM);
    }
    data.nextId = Math.max(data.nextId, ...data.messages.map((message) => message.id + 1), 1);
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not load chat history: ${error.message}`);
  }
}

function persistData() {
  const snapshot = JSON.stringify(data);
  writes = writes.then(async () => {
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fs.writeFile(temporaryFile, snapshot, "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
  });
  return writes;
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function findUser(id) {
  return data.users.find((user) => user.id === id);
}

function findConversation(id) {
  return data.conversations.find((conversation) => conversation.id === id);
}

function canAccess(conversation, clientId) {
  return conversation.type === "room" || conversation.members.includes(clientId);
}

function conversationPreview(conversation, clientId) {
  const messages = data.messages.filter((message) => message.conversationId === conversation.id);
  const latest = messages[messages.length - 1] || null;
  const otherUsers = conversation.members
    .filter((memberId) => memberId !== clientId)
    .map((memberId) => findUser(memberId))
    .filter(Boolean);

  return {
    ...conversation,
    members: conversation.members.map((memberId) => {
      const user = findUser(memberId);
      return user ? { id: user.id, name: user.name } : null;
    }).filter(Boolean),
    displayName: conversation.type === "dm" ? (otherUsers[0]?.name || "Unknown person") : conversation.name,
    subtitle: conversation.type === "dm"
      ? "Direct message"
      : conversation.type === "group"
        ? `${conversation.members.length} members`
        : "A shared place to chat",
    latestMessage: latest ? { text: latest.text, sender: latest.sender, createdAt: latest.createdAt } : null,
    updatedAt: latest?.createdAt || conversation.createdAt || "",
  };
}

async function serveStatic(pathname, response) {
  const files = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js" };
  const filename = files[pathname];
  if (!filename) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  const filePath = path.join(PUBLIC_DIR, filename);
  const contents = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath)],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(contents);
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/profile" && request.method === "POST") {
    const body = await readJson(request);
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (id.length < 1 || id.length > 64 || name.length < 1 || name.length > 32) {
      sendJson(response, 400, { error: "A device ID and a name between 1 and 32 characters are required." });
      return;
    }
    const user = { id, name, updatedAt: new Date().toISOString() };
    const existingIndex = data.users.findIndex((item) => item.id === id);
    if (existingIndex < 0) data.users.push(user);
    else data.users[existingIndex] = user;
    await persistData();
    sendJson(response, 200, { user: { id: user.id, name: user.name } });
    return;
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    const clientId = url.searchParams.get("clientId") || "";
    const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
    const users = data.users
      .filter((user) => user.id !== clientId && (!query || user.name.toLocaleLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
      .map(({ id, name }) => ({ id, name }));
    sendJson(response, 200, { users });
    return;
  }

  if (url.pathname === "/api/conversations" && request.method === "GET") {
    const clientId = url.searchParams.get("clientId") || "";
    sendJson(response, 200, {
      conversations: data.conversations
        .filter((conversation) => canAccess(conversation, clientId))
        .map((conversation) => conversationPreview(conversation, clientId))
        .sort((a, b) => {
          if (a.id === ROOM.id) return -1;
          if (b.id === ROOM.id) return 1;
          return b.updatedAt.localeCompare(a.updatedAt);
        }),
    });
    return;
  }

  if (url.pathname === "/api/conversations" && request.method === "POST") {
    const body = await readJson(request);
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const type = body.type;
    const creator = findUser(clientId);
    if (!creator) {
      sendJson(response, 401, { error: "Set your profile before creating a conversation." });
      return;
    }
    if (type !== "dm" && type !== "group") {
      sendJson(response, 400, { error: "Choose a direct message or group conversation." });
      return;
    }
    const requestedIds = Array.isArray(body.memberIds)
      ? [...new Set(body.memberIds.filter((id) => typeof id === "string" && id !== clientId))]
      : [];
    if (requestedIds.length < 1 || requestedIds.length > MAX_GROUP_MEMBERS - 1) {
      sendJson(response, 400, { error: `Choose between 1 and ${MAX_GROUP_MEMBERS - 1} other people.` });
      return;
    }
    const participants = [clientId, ...requestedIds];
    if (requestedIds.some((id) => !findUser(id))) {
      sendJson(response, 400, { error: "One or more selected people are no longer available." });
      return;
    }

    if (type === "dm") {
      if (requestedIds.length !== 1) {
        sendJson(response, 400, { error: "A direct message can only have one other person." });
        return;
      }
      const memberIds = [...participants].sort();
      let conversation = data.conversations.find((item) =>
        item.type === "dm" && item.members.length === 2 && item.members.every((id) => memberIds.includes(id)));
      if (!conversation) {
        conversation = { id: `dm-${memberIds.join("-")}`, type: "dm", members: memberIds, createdAt: new Date().toISOString() };
        data.conversations.push(conversation);
        await persistData();
      }
      sendJson(response, 200, { conversation: conversationPreview(conversation, clientId) });
      return;
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 40) {
      sendJson(response, 400, { error: "Group names must be between 2 and 40 characters." });
      return;
    }
    const conversation = {
      id: `group-${randomUUID()}`,
      type: "group",
      name,
      members: participants,
      createdAt: new Date().toISOString(),
    };
    data.conversations.push(conversation);
    await persistData();
    sendJson(response, 201, { conversation: conversationPreview(conversation, clientId) });
    return;
  }

  const messageRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageRoute && request.method === "GET") {
    const conversationId = decodeURIComponent(messageRoute[1]);
    const clientId = url.searchParams.get("clientId") || "";
    const after = Number(url.searchParams.get("after") || 0);
    const conversation = findConversation(conversationId);
    if (!conversation || !canAccess(conversation, clientId)) {
      sendJson(response, 404, { error: "Conversation not found." });
      return;
    }
    if (!Number.isSafeInteger(after) || after < 0) {
      sendJson(response, 400, { error: "The message cursor must be a non-negative integer." });
      return;
    }
    sendJson(response, 200, {
      messages: data.messages.filter((message) => message.conversationId === conversationId && message.id > after),
    });
    return;
  }

  if (messageRoute && request.method === "POST") {
    const conversationId = decodeURIComponent(messageRoute[1]);
    const body = await readJson(request);
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const sender = typeof body.sender === "string" ? body.sender.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const conversation = findConversation(conversationId);
    if (!conversation || !canAccess(conversation, clientId)) {
      sendJson(response, 404, { error: "Conversation not found." });
      return;
    }
    if (!findUser(clientId) || findUser(clientId).name !== sender) {
      sendJson(response, 401, { error: "Your profile is out of date. Refresh and try again." });
      return;
    }
    if (text.length < 1 || text.length > 2000) {
      sendJson(response, 400, { error: "Messages must be between 1 and 2,000 characters." });
      return;
    }
    const message = {
      id: data.nextId++,
      conversationId,
      clientId,
      sender,
      text,
      createdAt: new Date().toISOString(),
    };
    data.messages.push(message);
    if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
    await persistData();
    sendJson(response, 201, { message });
    return;
  }

  sendJson(response, 404, { error: "API endpoint not found." });
}

async function handleNeonRequest(request, response, url) {
  const { profile, users, conversations, messages } = require("./serverless/chat");
  const messageRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  const query = Object.fromEntries(url.searchParams.entries());
  let handler;

  if (url.pathname === "/api/profile") handler = profile;
  else if (url.pathname === "/api/users") handler = users;
  else if (url.pathname === "/api/conversations") handler = conversations;
  else if (messageRoute) {
    handler = messages;
    query.id = decodeURIComponent(messageRoute[1]);
  } else {
    sendJson(response, 404, { error: "API endpoint not found." });
    return;
  }

  const body = request.method === "POST" ? await readJson(request) : {};
  const apiResponse = {
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    setHeader(name, value) {
      response.setHeader(name, value);
      return this;
    },
    json(value) {
      sendJson(response, response.statusCode || 200, value);
      return this;
    },
  };
  await handler({ method: request.method, query, body }, apiResponse);
}

function localAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) addresses.push(item.address);
    }
  }
  return [...new Set(addresses)];
}

async function start() {
  if (!process.env.DATABASE_URL) await loadData();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const operation = url.pathname.startsWith("/api/")
      ? process.env.DATABASE_URL
        ? handleNeonRequest(request, response, url)
        : handleApi(request, response, url)
      : request.method === "GET" || request.method === "HEAD"
        ? serveStatic(url.pathname, response)
        : Promise.resolve(sendJson(response, 405, { error: "Method not allowed." }));
    operation.catch((error) => {
      if (response.headersSent || response.destroyed) return;
      const status = error.statusCode || 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, { error: status >= 500 ? "The server could not complete the request." : error.message });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`ChatyPeople is running at http://localhost:${PORT}`);
    if (process.env.DATABASE_URL) console.log("Using Neon Postgres as the chat backend.");
    for (const address of localAddresses()) console.log(`On your Wi-Fi: http://${address}:${PORT}`);
    console.log("Keep this terminal open while chatting.");
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
