const appShell = document.querySelector(".app-shell");
const conversationList = document.querySelector("#conversation-list");
const conversationSearch = document.querySelector("#conversation-search");
const inboxCount = document.querySelector("#inbox-count");
const messageArea = document.querySelector("#message-area");
const messagesElement = document.querySelector("#messages");
const welcomeCard = document.querySelector("#welcome-card");
const chatTitle = document.querySelector("#chat-title");
const chatSubtitle = document.querySelector("#chat-subtitle");
const chatAvatar = document.querySelector("#chat-avatar");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const composerHint = document.querySelector("#composer-hint");
const nameDialog = document.querySelector("#name-dialog");
const nameForm = document.querySelector("#name-form");
const nameInput = document.querySelector("#name-input");
const profileButton = document.querySelector("#profile-button");
const profileName = document.querySelector("#profile-name");
const profileAvatar = document.querySelector("#profile-avatar");
const newChatDialog = document.querySelector("#new-chat-dialog");
const peopleSearch = document.querySelector("#people-search");
const peopleList = document.querySelector("#people-list");
const groupNameWrap = document.querySelector("#group-name-wrap");
const groupNameInput = document.querySelector("#group-name");
const selectedPeopleElement = document.querySelector("#selected-people");
const selectionHint = document.querySelector("#selection-hint");
const createConversationButton = document.querySelector("#create-conversation");
const directModeButton = document.querySelector("#direct-mode");
const groupModeButton = document.querySelector("#group-mode");
const toast = document.querySelector("#toast");
const notificationsButton = document.querySelector("#notifications-button");
const installButton = document.querySelector("#install-button");

const CLIENT_ID_KEY = "chatypeople-client-id";
const NAME_KEY = "chatypeople-name";
const NOTIFICATIONS_KEY = "chatypeople-notifications";
const clientId = getOrCreateClientId();
let displayName = localStorage.getItem(NAME_KEY) || "";
let notificationsEnabled = localStorage.getItem(NOTIFICATIONS_KEY) === "true";
let conversations = [];
let currentConversation = null;
let cursor = 0;
let pollInProgress = false;
let isGroupMode = false;
let people = [];
let selectedPeople = new Map();
let toastTimeout;
let peopleSearchTimeout;
let deferredInstallPrompt = null;

function getOrCreateClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function initials(name) {
  return Array.from((name || "").trim())[0]?.toUpperCase() || "?";
}

function colorFor(name) {
  let hash = 0;
  for (const character of name || "") hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const colors = ["#8064d8", "#488b91", "#bc648d", "#b18448", "#537db8", "#658553", "#c56d59"];
  return colors[Math.abs(hash) % colors.length];
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4000);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function updateProfile() {
  profileName.textContent = displayName || "Set your name";
  profileAvatar.textContent = initials(displayName);
  profileAvatar.style.setProperty("--avatar-color", colorFor(displayName));
}

function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled || !currentConversation;
  sendButton.disabled = !enabled || !currentConversation;
  composerHint.innerHTML = enabled
    ? 'Your chats stay on this laptop <span>·</span> Enter to send'
    : "Set your name to start chatting";
}

function openNameDialog() {
  nameInput.value = displayName;
  nameDialog.showModal();
  requestAnimationFrame(() => nameInput.focus());
}

function formatTime(value, includeDate = false) {
  const date = new Date(value);
  const now = new Date();
  if (includeDate && date.toDateString() !== now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function createAvatar(label, className = "conversation-avatar") {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.textContent = initials(label);
  avatar.style.setProperty("--avatar-color", colorFor(label));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function conversationLabel(conversation) {
  return conversation.displayName || conversation.name || "Conversation";
}

function previewText(conversation) {
  if (!conversation.latestMessage) {
    if (conversation.id === "lounge") return "A good place to say hello";
    return conversation.type === "group" ? "Group conversation" : "Start a conversation";
  }
  const prefix = conversation.latestMessage.sender === displayName ? "You: " : "";
  return `${prefix}${conversation.latestMessage.text}`;
}

function renderConversations() {
  const query = conversationSearch.value.trim().toLocaleLowerCase();
  const filtered = conversations.filter((conversation) =>
    `${conversationLabel(conversation)} ${previewText(conversation)}`.toLocaleLowerCase().includes(query));
  conversationList.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "conversation-empty";
    empty.textContent = query ? "No chats found. Try finding a person." : "No conversations yet.";
    conversationList.append(empty);
    return;
  }

  for (const conversation of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${conversation.id === currentConversation?.id ? " active" : ""}`;
    button.dataset.conversationId = conversation.id;
    const avatar = createAvatar(conversationLabel(conversation));
    if (conversation.type === "group") avatar.classList.add("group-avatar");
    if (conversation.id === "lounge") avatar.classList.add("lounge-avatar");
    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const topLine = document.createElement("span");
    topLine.className = "conversation-topline";
    const title = document.createElement("strong");
    title.textContent = conversationLabel(conversation);
    const time = document.createElement("time");
    time.textContent = conversation.latestMessage ? formatTime(conversation.latestMessage.createdAt, true) : "";
    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = previewText(conversation);
    const subtitle = document.createElement("span");
    subtitle.className = "conversation-kind";
    subtitle.textContent = conversation.type === "group" ? "GROUP" : conversation.type === "room" ? "COMMUNITY" : "DIRECT";
    topLine.append(title, time);
    copy.append(topLine, preview);
    button.append(avatar, copy, subtitle);
    conversationList.append(button);
  }
  inboxCount.textContent = String(Math.max(1, conversations.length));
}

function updateHeader(conversation) {
  const label = conversationLabel(conversation);
  chatTitle.textContent = label;
  chatSubtitle.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "tiny-online";
  chatSubtitle.append(dot, document.createTextNode(conversation.subtitle || "Conversation"));
  chatAvatar.textContent = initials(label);
  chatAvatar.style.setProperty("--avatar-color", colorFor(label));
  chatAvatar.className = `chat-avatar${conversation.type === "group" ? " group-avatar" : ""}`;
  if (conversation.type !== "room") {
    const online = document.createElement("span");
    online.className = "online-indicator";
    chatAvatar.append(online);
  }
}

async function loadConversations() {
  const result = await requestJson(`/api/conversations?clientId=${encodeURIComponent(clientId)}`);
  conversations = result.conversations;
  renderConversations();
  return conversations;
}

function renderMessage(message) {
  const outgoing = message.clientId === clientId;
  const row = document.createElement("article");
  row.className = `message${outgoing ? " outgoing" : " incoming"}`;
  row.dataset.messageId = String(message.id);

  if (!outgoing && currentConversation?.type === "group") {
    row.append(createAvatar(message.sender, "message-avatar"));
  }

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = message.sender;
  sender.style.color = outgoing ? "#ead8ff" : colorFor(message.sender);
  bubble.append(sender);

  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message.text;
  const meta = document.createElement("span");
  meta.className = "message-meta";
  const time = document.createElement("time");
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt);
  if (message.editedAt) {
    const edited = document.createElement("span");
    edited.className = "message-edited";
    edited.textContent = "Edited";
    meta.append(edited);
  }
  meta.append(time);
  if (outgoing) {
    const receipt = document.createElement("span");
    receipt.className = "message-receipt";
    receipt.textContent = "✓✓";
    receipt.setAttribute("aria-label", "Sent");
    meta.append(receipt);
  }
  bubble.append(text, meta);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.dataset.messageAction = "copy";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy message");
  actions.append(copy);
  if (outgoing) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.messageAction = "edit";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit message");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.messageAction = "delete";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", "Delete message");
    actions.append(edit, remove);
  }
  bubble.append(actions);
  row.append(bubble);
  return row;
}

async function loadMessages(scrollToBottom = false, force = false) {
  if (!currentConversation || !displayName || (pollInProgress && !force)) return;
  const conversationId = currentConversation.id;
  const after = force ? 0 : cursor;
  pollInProgress = true;
  try {
    const result = await requestJson(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?clientId=${encodeURIComponent(clientId)}&after=${after}`,
    );
    if (currentConversation?.id !== conversationId) return;
    if (force) {
      messagesElement.replaceChildren();
      cursor = 0;
    }
    const fragment = document.createDocumentFragment();
    for (const message of result.messages) {
      if (!force) notifyIncomingMessage(message);
      fragment.append(renderMessage(message));
      cursor = Math.max(cursor, message.id);
    }
    messagesElement.append(fragment);
    welcomeCard.hidden = messagesElement.childElementCount > 0;
    if (scrollToBottom || result.messages.length) messageArea.scrollTop = messageArea.scrollHeight;
  } catch (error) {
    showToast(error.message || "Couldn't load this conversation.");
  } finally {
    pollInProgress = false;
  }
}

function beginMessageEdit(row) {
  const text = row.querySelector(".message-text");
  if (!text || row.querySelector(".message-editor")) return;
  const editor = document.createElement("textarea");
  editor.className = "message-editor";
  editor.maxLength = 2000;
  editor.value = text.textContent;
  text.replaceWith(editor);
  const controls = document.createElement("div");
  controls.className = "message-edit-controls";
  for (const [action, label] of [["save", "Save"], ["cancel", "Cancel"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.messageAction = action;
    button.textContent = label;
    controls.append(button);
  }
  const meta = row.querySelector(".message-meta");
  row.querySelector(".message-bubble").insertBefore(controls, meta);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

async function saveMessageEdit(row) {
  const editor = row.querySelector(".message-editor");
  const text = editor?.value.trim();
  if (!text) {
    showToast("Messages can't be empty.");
    editor?.focus();
    return;
  }
  await requestJson(`/api/conversations/${encodeURIComponent(currentConversation.id)}/messages`, {
    method: "PATCH",
    body: JSON.stringify({ clientId, messageId: row.dataset.messageId, text }),
  });
  await loadMessages(false, true);
  await loadConversations();
}

async function deleteMessage(row) {
  if (!window.confirm("Delete this message for everyone in the conversation?")) return;
  await requestJson(`/api/conversations/${encodeURIComponent(currentConversation.id)}/messages`, {
    method: "DELETE",
    body: JSON.stringify({ clientId, messageId: row.dataset.messageId }),
  });
  await loadMessages(false, true);
  await loadConversations();
}

function updateNotificationsButton() {
  notificationsButton.classList.toggle("enabled", notificationsEnabled);
  notificationsButton.setAttribute("aria-pressed", String(notificationsEnabled));
  notificationsButton.setAttribute("aria-label", notificationsEnabled ? "Turn off notifications" : "Enable notifications");
  notificationsButton.title = notificationsEnabled ? "Turn off notifications" : "Enable notifications";
}

function decodeApplicationKey(value) {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function notifyIncomingMessage(message) {
  if (!notificationsEnabled || message.clientId === clientId || !document.hidden || !("Notification" in window)) return;
  const conversation = conversations.find((item) => item.id === message.conversationId);
  const title = `${message.sender} · ${conversation ? conversationLabel(conversation) : "New message"}`;
  const options = {
    body: message.text,
    icon: "/icon.svg",
    tag: `chat-${message.conversationId}-${message.id}`,
    data: { conversationId: message.conversationId },
  };
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      const target = conversations.find((item) => item.id === message.conversationId);
      if (target) selectConversation(target);
      notification.close();
    };
  } catch (error) {
    console.error("Could not show a browser notification:", error);
  }
}

async function toggleNotifications() {
  if (!("Notification" in window)) {
    showToast("This browser doesn't support notifications.");
    return;
  }
  if (notificationsEnabled) {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        await requestJson("/api/notifications", {
          method: "POST",
          body: JSON.stringify({ clientId, action: "unsubscribe", endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
    } catch (error) {
      console.error("Could not remove the push subscription:", error);
      showToast(error.message || "Couldn't turn off push notifications.");
    }
    notificationsEnabled = false;
    localStorage.setItem(NOTIFICATIONS_KEY, "false");
    updateNotificationsButton();
    showToast("Notifications are off.");
    return;
  }

  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== "granted") {
    showToast(permission === "denied"
      ? "Notifications are blocked. Allow them in your browser's site settings."
      : "Notification permission wasn't granted.");
    return;
  }

  notificationsEnabled = true;
  localStorage.setItem(NOTIFICATIONS_KEY, "true");
  updateNotificationsButton();
  let pushEnabled = false;
  if ("serviceWorker" in navigator && "PushManager" in window) {
    try {
      const { publicKey } = await requestJson("/api/notifications");
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeApplicationKey(publicKey),
        });
      }
      await requestJson("/api/notifications", {
        method: "POST",
        body: JSON.stringify({ clientId, subscription: subscription.toJSON() }),
      });
      pushEnabled = true;
    } catch (error) {
      if (error.status !== 404 && error.status !== 503) {
        console.error("Could not enable push notifications:", error);
        showToast(error.message || "Couldn't enable push notifications.");
      }
    }
  }
  showToast(pushEnabled
    ? "Push notifications are on, even when ChatyPeople isn't open."
    : "Browser notifications are on while ChatyPeople is open. Install the app for the best experience.");
}

async function installApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    showToast(choice.outcome === "accepted" ? "ChatyPeople is installing." : "You can install ChatyPeople any time from your browser menu.");
    return;
  }
  const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
  if (isAppleMobile) {
    showToast("To install on iPhone or iPad: tap Share, then Add to Home Screen.");
  } else if (window.matchMedia("(display-mode: standalone)").matches) {
    showToast("ChatyPeople is already installed.");
  } else {
    showToast("Use your browser menu and choose Install app or Add to Home Screen.");
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js")
    .catch((error) => {
      console.error("Could not register the app service worker:", error);
      showToast("Offline install support couldn't start in this browser.");
    });
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (event.data?.type !== "open-conversation") return;
    if (!conversations.length) await loadConversations();
    const target = conversations.find((item) => item.id === event.data.conversationId);
    if (target) await selectConversation(target);
  });
}

async function selectConversation(conversation) {
  currentConversation = conversation;
  cursor = 0;
  updateHeader(conversation);
  renderConversations();
  appShell.classList.add("mobile-chat-open");
  setComposerEnabled(Boolean(displayName));
  messageInput.placeholder = `Message ${conversationLabel(conversation)}…`;
  await loadMessages(true, true);
  messageInput.focus({ preventScroll: true });
}

async function openDirectMessage(person) {
  try {
    const result = await requestJson("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ clientId, type: "dm", memberIds: [person.id] }),
    });
    await loadConversations();
    await selectConversation(result.conversation);
    newChatDialog.close();
  } catch (error) {
    showToast(error.message);
  }
}

function renderPeople() {
  peopleList.replaceChildren();
  const query = peopleSearch.value.trim().toLocaleLowerCase();
  const results = people.filter((person) => person.name.toLocaleLowerCase().includes(query));
  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = query ? "No one found. Ask them to open this chat first." : "No other people have joined yet. Share your Wi-Fi chat link with a friend.";
    peopleList.append(empty);
    updateSelectionControls();
    return;
  }
  for (const person of results) {
    const button = document.createElement("button");
    const selected = selectedPeople.has(person.id);
    button.type = "button";
    button.className = `person-option${selected ? " selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(selected));
    button.dataset.personId = person.id;
    button.append(createAvatar(person.name, "person-avatar"));
    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = person.name;
    button.append(name);
    if (isGroupMode) {
      const check = document.createElement("span");
      check.className = "person-check";
      check.textContent = selected ? "✓" : "";
      button.append(check);
    } else {
      const arrow = document.createElement("span");
      arrow.className = "person-arrow";
      arrow.textContent = "↗";
      button.append(arrow);
    }
    peopleList.append(button);
  }
  updateSelectionControls();
}

function updateSelectionControls() {
  selectedPeopleElement.replaceChildren();
  for (const person of selectedPeople.values()) {
    const chip = document.createElement("span");
    chip.className = "selected-chip";
    const label = document.createElement("span");
    label.textContent = person.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.removePersonId = person.id;
    remove.setAttribute("aria-label", `Remove ${person.name}`);
    remove.textContent = "×";
    chip.append(label, remove);
    selectedPeopleElement.append(chip);
  }

  if (isGroupMode) {
    createConversationButton.disabled = selectedPeople.size < 1 || groupNameInput.value.trim().length < 2;
    selectionHint.textContent = selectedPeople.size
      ? `${selectedPeople.size + 1} people in this group`
      : "Choose people to add to your group";
  } else {
    createConversationButton.disabled = true;
    selectionHint.textContent = "Choose someone to start a chat";
  }
}

async function searchPeople() {
  if (!displayName) return;
  try {
    const query = peopleSearch.value.trim();
    const result = await requestJson(
      `/api/users?clientId=${encodeURIComponent(clientId)}&q=${encodeURIComponent(query)}`,
    );
    people = result.users;
    renderPeople();
  } catch (error) {
    showToast(error.message);
  }
}

async function openNewChat() {
  if (!displayName) {
    openNameDialog();
    return;
  }
  selectedPeople.clear();
  peopleSearch.value = "";
  groupNameInput.value = "";
  setMode(false);
  newChatDialog.showModal();
  await searchPeople();
  peopleSearch.focus();
}

function setMode(groupMode) {
  isGroupMode = groupMode;
  directModeButton.classList.toggle("selected", !groupMode);
  groupModeButton.classList.toggle("selected", groupMode);
  directModeButton.setAttribute("aria-selected", String(!groupMode));
  groupModeButton.setAttribute("aria-selected", String(groupMode));
  groupNameWrap.hidden = !groupMode;
  selectedPeople.clear();
  renderPeople();
  peopleSearch.placeholder = groupMode ? "Add people to your group…" : "Search people by name…";
  createConversationButton.textContent = groupMode ? "Create group" : "Start chatting";
  createConversationButton.disabled = true;
}

async function createGroup() {
  const name = groupNameInput.value.trim();
  if (!name || selectedPeople.size === 0) return;
  createConversationButton.disabled = true;
  try {
    const result = await requestJson("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ clientId, type: "group", name, memberIds: [...selectedPeople.keys()] }),
    });
    await loadConversations();
    await selectConversation(result.conversation);
    newChatDialog.close();
  } catch (error) {
    showToast(error.message);
  } finally {
    updateSelectionControls();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !displayName || !currentConversation) return;
  const conversationId = currentConversation.id;
  sendButton.disabled = true;
  try {
    await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ clientId, sender: displayName, text }),
    });
    messageInput.value = "";
    resizeInput();
    await loadMessages(true, true);
    await loadConversations();
    messageInput.focus({ preventScroll: true });
  } catch (error) {
    showToast(error.message || "Couldn't send your message.");
  } finally {
    sendButton.disabled = !displayName || !currentConversation;
  }
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
}

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextName = nameInput.value.trim();
  if (!nextName) {
    nameInput.focus();
    return;
  }
  const submitButton = nameForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const savedName = nextName.slice(0, 32);
    await requestJson("/api/profile", {
      method: "POST",
      body: JSON.stringify({ id: clientId, name: savedName }),
    });
    displayName = savedName;
    localStorage.setItem(NAME_KEY, displayName);
    updateProfile();
    setComposerEnabled(true);
    nameDialog.close();
    await loadConversations();
    messageInput.focus();
  } catch (error) {
    showToast(error.message || "Couldn't save your profile.");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#new-chat-button").addEventListener("click", openNewChat);
document.querySelector("#new-message-link").addEventListener("click", openNewChat);
document.querySelector("#welcome-new-chat").addEventListener("click", openNewChat);
document.querySelector("#composer-people").addEventListener("click", openNewChat);
document.querySelector("#header-search-button").addEventListener("click", openNewChat);
profileButton.addEventListener("click", openNameDialog);
document.querySelector("#new-chat-close").addEventListener("click", () => newChatDialog.close());
document.querySelector("#back-button").addEventListener("click", () => appShell.classList.remove("mobile-chat-open"));
document.querySelector("#details-button").addEventListener("click", () => {
  if (!currentConversation) return;
  const names = currentConversation.members?.map((member) => member.name).join(", ");
  showToast(currentConversation.type === "group" ? `${currentConversation.name} · ${names || "Just you"}` : currentConversation.subtitle);
});
document.querySelectorAll(".dialog-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

conversationSearch.addEventListener("input", renderConversations);
conversationList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-conversation-id]");
  if (!button) return;
  const conversation = conversations.find((item) => item.id === button.dataset.conversationId);
  if (conversation) await selectConversation(conversation);
});

peopleSearch.addEventListener("input", () => {
  clearTimeout(peopleSearchTimeout);
  peopleSearchTimeout = setTimeout(searchPeople, 140);
});
messagesElement.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-message-action]");
  if (!button) return;
  const row = button.closest(".message");
  if (!row) return;
  const action = button.dataset.messageAction;
  try {
    if (action === "edit") beginMessageEdit(row);
    else if (action === "cancel") {
      const editor = row.querySelector(".message-editor");
      if (!editor) return;
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = editor.value;
      editor.replaceWith(text);
      row.querySelector(".message-edit-controls")?.remove();
    } else if (action === "save") await saveMessageEdit(row);
    else if (action === "delete") await deleteMessage(row);
    else if (action === "copy") {
      const text = row.querySelector(".message-text")?.textContent || "";
      await navigator.clipboard.writeText(text);
      showToast("Message copied.");
    }
  } catch (error) {
    showToast(error.message || "Couldn't update the message.");
  }
});
messagesElement.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && event.target.matches(".message-editor")) {
    const row = event.target.closest(".message");
    const cancel = row?.querySelector('[data-message-action="cancel"]');
    cancel?.click();
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target.matches(".message-editor")) {
    const save = event.target.closest(".message")?.querySelector('[data-message-action="save"]');
    save?.click();
  }
});
peopleList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-person-id]");
  if (!button) return;
  const person = people.find((item) => item.id === button.dataset.personId);
  if (!person) return;
  if (!isGroupMode) {
    await openDirectMessage(person);
    return;
  }
  if (selectedPeople.has(person.id)) selectedPeople.delete(person.id);
  else selectedPeople.set(person.id, person);
  renderPeople();
});
selectedPeopleElement.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-person-id]");
  if (!button) return;
  selectedPeople.delete(button.dataset.removePersonId);
  renderPeople();
});
directModeButton.addEventListener("click", () => setMode(false));
groupModeButton.addEventListener("click", () => setMode(true));
groupNameInput.addEventListener("input", updateSelectionControls);

messageInput.addEventListener("input", resizeInput);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});
messageForm.addEventListener("submit", sendMessage);
notificationsButton.addEventListener("click", toggleNotifications);
installButton.addEventListener("click", installApp);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  showToast("ChatyPeople is installed on this device.");
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    conversationSearch.focus();
  }
});

async function initialize() {
  updateNotificationsButton();
  registerServiceWorker();
  updateProfile();
  if (!displayName) {
    openNameDialog();
    return;
  }
  try {
    await requestJson("/api/profile", {
      method: "POST",
      body: JSON.stringify({ id: clientId, name: displayName }),
    });
    setComposerEnabled(true);
    await loadConversations();
    const requestedConversationId = new URLSearchParams(window.location.search).get("conversation");
    const initialConversation = conversations.find((item) => item.id === requestedConversationId)
      || conversations.find((item) => item.id === "lounge")
      || conversations[0];
    if (initialConversation) await selectConversation(initialConversation);
  } catch (error) {
    showToast(error.message || "Couldn't connect to the chat. Check that the server is running.");
  }
}

initialize();
setInterval(async () => {
  if (!displayName) return;
  try {
    await loadConversations();
    await loadMessages();
  } catch (error) {
    showToast(error.message || "Couldn't refresh your conversations.");
  }
}, 1800);
