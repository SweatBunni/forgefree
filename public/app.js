const STORAGE_KEY = "forgefreeai-render-state-v1";
const BUILD_POLL_INTERVAL_MS = 2500;

const elements = {
  chatList: document.getElementById("chat-list"),
  chatCount: document.getElementById("chat-count"),
  chatTitle: document.getElementById("chat-title"),
  hostLabel: document.getElementById("host-label"),
  modelLabel: document.getElementById("model-label"),
  statusText: document.getElementById("status-text"),
  messages: document.getElementById("messages"),
  promptInput: document.getElementById("prompt-input"),
  loaderSelect: document.getElementById("loader-select"),
  versionInput: document.getElementById("version-input"),
  composerForm: document.getElementById("composer-form"),
  sendButton: document.getElementById("send-button"),
  newChatButton: document.getElementById("new-chat-button"),
  buildJarButton: document.getElementById("build-jar-button"),
  downloadSourceButton: document.getElementById("download-source-button"),
};

const runtime = {
  hostingTarget: "local",
  model: "codestral-latest",
  buildJobsSupported: true,
  jarBuildSupported: true,
};

const requestState = {
  sending: false,
};

const jobPollers = new Map();
let currentStatus = "Ready.";

let state = loadState();

init();

function init() {
  bindEvents();
  ensureStateShape();
  render();
  refreshHealth();
  resumePendingBuilds();
}

function bindEvents() {
  elements.newChatButton.addEventListener("click", () => {
    const chat = createChat();
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
    saveState();
    render();
    setStatus("Started a fresh chat.");
  });

  elements.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendPrompt();
  });

  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });

  elements.loaderSelect.addEventListener("change", () => {
    updateActivePreferences({
      loader: elements.loaderSelect.value,
    });
  });

  elements.versionInput.addEventListener("change", () => {
    updateActivePreferences({
      minecraftVersion: elements.versionInput.value.trim(),
    });
  });

  elements.buildJarButton.addEventListener("click", async () => {
    await handleBuildAction("jar");
  });

  elements.downloadSourceButton.addEventListener("click", async () => {
    await handleBuildAction("source");
  });
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createInitialState();
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : createInitialState();
  } catch (_error) {
    return createInitialState();
  }
}

function createInitialState() {
  const chat = createChat();
  return {
    chats: [chat],
    activeChatId: chat.id,
  };
}

function createChat() {
  const chat = {
    id: generateId(),
    title: "New Minecraft Project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preferences: {
      loader: "auto",
      minecraftVersion: "1.21.1",
    },
    latestBuild: null,
    activeBuildJobId: "",
    pendingBuildMessageId: "",
    requestedArtifactKind: "",
    messages: [],
  };

  chat.messages.push(
    createMessage(
      "assistant",
      "ForgefreeAI is ready. Ask for a Minecraft Java mod, plugin, datapack, or resource pack, then use Download JAR or Download Source when you want the finished files.",
      {
        stageLabel: "Welcome",
        contextExcluded: true,
      }
    )
  );

  return chat;
}

function ensureStateShape() {
  if (!Array.isArray(state.chats) || state.chats.length === 0) {
    state = createInitialState();
    saveState();
    return;
  }

  for (const chat of state.chats) {
    if (!chat.id) {
      chat.id = generateId();
    }
    if (!chat.title) {
      chat.title = "New Minecraft Project";
    }
    if (!chat.preferences || typeof chat.preferences !== "object") {
      chat.preferences = {};
    }
    chat.preferences.loader = normalizeLoader(chat.preferences.loader);
    chat.preferences.minecraftVersion = normalizeVersion(chat.preferences.minecraftVersion) || "1.21.1";
    if (!Array.isArray(chat.messages)) {
      chat.messages = [];
    }
    if (typeof chat.latestBuild !== "object") {
      chat.latestBuild = null;
    }
    chat.activeBuildJobId = String(chat.activeBuildJobId || "");
    chat.pendingBuildMessageId = String(chat.pendingBuildMessageId || "");
    chat.requestedArtifactKind = String(chat.requestedArtifactKind || "");
  }

  if (!state.activeChatId || !state.chats.some((chat) => chat.id === state.activeChatId)) {
    state.activeChatId = state.chats[0].id;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0];
}

function findChatById(chatId) {
  return state.chats.find((chat) => chat.id === chatId) || null;
}

function createMessage(role, content, extra = {}) {
  return {
    id: generateId(),
    role,
    content,
    createdAt: Date.now(),
    artifacts: [],
    stageLabel: "",
    contextExcluded: false,
    ...extra,
  };
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLoader(value) {
  const allowed = new Set([
    "auto",
    "fabric",
    "forge",
    "neoforge",
    "paper",
    "spigot",
    "bukkit",
    "velocity",
    "datapack",
    "resource-pack",
  ]);
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  return allowed.has(normalized) ? normalized : "auto";
}

function normalizeVersion(value) {
  const normalized = String(value || "").trim();
  return /^[0-9]+(?:\.[0-9]+){1,3}$/.test(normalized) ? normalized : "";
}

function updateActivePreferences(partial) {
  const chat = getActiveChat();
  chat.preferences = {
    ...chat.preferences,
    ...partial,
    loader: normalizeLoader(partial.loader ?? chat.preferences.loader),
    minecraftVersion:
      normalizeVersion(partial.minecraftVersion ?? chat.preferences.minecraftVersion) ||
      chat.preferences.minecraftVersion ||
      "1.21.1",
  };
  chat.latestBuild = null;
  chat.updatedAt = Date.now();
  saveState();
  render();
  setStatus("Updated the preferred loader/version for this chat.");
}

function render() {
  renderSidebar();
  renderWorkspace();
  updateButtons();
}

function renderSidebar() {
  elements.chatCount.textContent = String(state.chats.length);
  elements.chatList.innerHTML = "";

  for (const chat of state.chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-item${chat.id === state.activeChatId ? " active" : ""}`;
    button.innerHTML = `
      <span class="chat-item-title">${escapeHtml(chat.title)}</span>
      <span class="chat-item-meta">${escapeHtml(buildChatMeta(chat))}</span>
    `;
    button.addEventListener("click", () => {
      state.activeChatId = chat.id;
      saveState();
      render();
      if (chat.activeBuildJobId) {
        startBuildPolling(chat.id, chat.activeBuildJobId);
      }
    });
    elements.chatList.appendChild(button);
  }
}

function buildChatMeta(chat) {
  const loaderLabel = formatLoader(chat.preferences.loader);
  const version = chat.preferences.minecraftVersion || "1.21.1";
  if (chat.activeBuildJobId) {
    return `${loaderLabel} • ${version} • Build running`;
  }
  return `${loaderLabel} • ${version}`;
}

function renderWorkspace() {
  const chat = getActiveChat();
  elements.chatTitle.textContent = chat.title;
  elements.hostLabel.textContent = formatHostLabel(runtime.hostingTarget);
  elements.modelLabel.textContent = runtime.model;
  elements.statusText.textContent = currentStatus;
  elements.loaderSelect.value = normalizeLoader(chat.preferences.loader);
  elements.versionInput.value = chat.preferences.minecraftVersion || "1.21.1";

  elements.messages.innerHTML = "";

  if (!chat.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <h3>Start a Minecraft build conversation.</h3>
      <p>Describe the project, pick the loader and version below, then let ForgefreeAI generate, repair, and package the final files.</p>
    `;
    elements.messages.appendChild(empty);
    return;
  }

  for (const message of chat.messages) {
    elements.messages.appendChild(renderMessage(message));
  }

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role === "user" ? "user" : "assistant"}`;

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerHTML = `
    <span class="message-role">${message.role === "user" ? "You" : "ForgefreeAI"}</span>
    <span class="message-stage">${escapeHtml(message.stageLabel || "")}</span>
  `;
  wrapper.appendChild(header);

  const body = document.createElement("div");
  body.className = "message-body";
  appendRichText(body, message.content || "");

  if (Array.isArray(message.artifacts) && message.artifacts.length > 0) {
    const grid = document.createElement("div");
    grid.className = "artifact-grid";

    for (const artifact of message.artifacts) {
      const card = document.createElement("div");
      card.className = "artifact-card";
      card.innerHTML = `
        <h3>${escapeHtml(artifact.kind === "jar" ? "Fixed JAR" : "Fixed Source ZIP")}</h3>
        <p>${escapeHtml(artifact.name || "Download")}</p>
      `;
      const button = document.createElement("a");
      button.className = "primary-button";
      button.href = artifact.downloadUrl;
      button.download = artifact.name || "";
      button.textContent = artifact.kind === "jar" ? "Download JAR" : "Download Source";
      card.appendChild(button);
      grid.appendChild(card);
    }

    body.appendChild(grid);
  }

  wrapper.appendChild(body);
  return wrapper;
}

function appendRichText(container, text) {
  const parts = String(text || "").split("```");
  parts.forEach((part, index) => {
    if (!part.trim()) {
      return;
    }

    if (index % 2 === 1) {
      const codeBlock = document.createElement("pre");
      codeBlock.className = "message-code";
      codeBlock.textContent = stripCodeFenceLanguage(part);
      container.appendChild(codeBlock);
      return;
    }

    const textBlock = document.createElement("pre");
    textBlock.className = "message-text";
    textBlock.textContent = part.trim();
    container.appendChild(textBlock);
  });
}

function stripCodeFenceLanguage(block) {
  const normalized = String(block || "").replace(/^\n+/, "");
  const match = normalized.match(/^[a-z0-9#+._-]+\n/i);
  return match ? normalized.slice(match[0].length) : normalized;
}

function updateButtons() {
  const chat = getActiveChat();
  const buildRunning = Boolean(chat.activeBuildJobId);
  const hasUserPrompt = chat.messages.some((message) => message.role === "user");

  elements.sendButton.disabled = requestState.sending;
  elements.buildJarButton.disabled =
    buildRunning || !hasUserPrompt || !runtime.buildJobsSupported || !runtime.jarBuildSupported;
  elements.downloadSourceButton.disabled =
    buildRunning || !hasUserPrompt || !runtime.buildJobsSupported;
}

async function refreshHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }
    const data = await readJsonResponse(response);
    runtime.hostingTarget = String(data.hostingTarget || "local");
    runtime.model = String(data.model || "codestral-latest");
    runtime.buildJobsSupported = Boolean(data.buildJobsSupported ?? data.sessionBuildSupported);
    runtime.jarBuildSupported = Boolean(data.jarBuildSupported);
    setStatus(`Connected to ${formatHostLabel(runtime.hostingTarget)}.`);
    render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    render();
  }
}

async function sendPrompt() {
  const prompt = elements.promptInput.value.trim();
  if (!prompt || requestState.sending) {
    return;
  }

  const chat = getActiveChat();
  requestState.sending = true;
  chat.latestBuild = null;

  const userMessage = createMessage("user", prompt);
  const assistantMessage = createMessage("assistant", "Thinking through the project requirements...", {
    stageLabel: "Thinking",
    contextExcluded: true,
  });

  chat.messages.push(userMessage, assistantMessage);
  chat.updatedAt = Date.now();
  chat.title = deriveChatTitle(chat);
  elements.promptInput.value = "";
  saveState();
  render();
  setStatus("Sending your Minecraft Java request to Codestral...");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: serializeConversation(chat),
        preferences: chat.preferences,
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    const data = await readJsonResponse(response);
    assistantMessage.content = data.content || "No response content returned.";
    assistantMessage.stageLabel = "Response";
    assistantMessage.contextExcluded = false;
    setStatus("Chat response ready.");
  } catch (error) {
    assistantMessage.content = `Request failed.\n\n${error instanceof Error ? error.message : String(error)}`;
    assistantMessage.stageLabel = "Error";
    setStatus("The chat request failed.");
  } finally {
    requestState.sending = false;
    chat.updatedAt = Date.now();
    saveState();
    render();
  }
}

function serializeConversation(chat) {
  const messages = chat.messages
    .filter((message) => !message.contextExcluded)
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  // Providers can reject chat payloads that end on an assistant turn.
  while (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.pop();
  }

  return messages;
}

async function handleBuildAction(kind) {
  const chat = getActiveChat();
  if (!chat.messages.some((message) => message.role === "user")) {
    setStatus("Ask for a Minecraft Java project first so there is something to build.");
    return;
  }

  if (!runtime.buildJobsSupported) {
    setStatus("This deployment cannot run background build jobs.");
    return;
  }

  const readyArtifact = findArtifact(chat.latestBuild, kind);
  if (readyArtifact) {
    triggerArtifactDownload(readyArtifact);
    setStatus(`Downloading ${readyArtifact.name}.`);
    return;
  }

  if (chat.activeBuildJobId) {
    chat.requestedArtifactKind = kind;
    saveState();
    startBuildPolling(chat.id, chat.activeBuildJobId);
    setStatus("The current build is still running. Waiting for the finished downloads...");
    return;
  }

  const pendingMessage = createMessage(
    "assistant",
    "Starting a background build. ForgefreeAI will generate the project, read the build logs, repair errors, and attach the final downloads here when it finishes.",
    {
      stageLabel: "Queued",
      contextExcluded: true,
    }
  );

  chat.messages.push(pendingMessage);
  chat.pendingBuildMessageId = pendingMessage.id;
  chat.requestedArtifactKind = kind;
  chat.updatedAt = Date.now();
  saveState();
  render();
  setStatus("Starting the build job on the server...");

  try {
    const response = await fetch("/api/build/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: serializeConversation(chat),
        preferences: chat.preferences,
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    const data = await readJsonResponse(response);
    chat.activeBuildJobId = data.jobId || "";
    pendingMessage.content = data.message || "Background build started.";
    pendingMessage.stageLabel = "Queued";
    chat.updatedAt = Date.now();
    saveState();
    render();
    startBuildPolling(chat.id, chat.activeBuildJobId);
  } catch (error) {
    pendingMessage.content = `Build failed.\n\n${error instanceof Error ? error.message : String(error)}`;
    pendingMessage.stageLabel = "Error";
    chat.activeBuildJobId = "";
    chat.pendingBuildMessageId = "";
    chat.requestedArtifactKind = "";
    chat.updatedAt = Date.now();
    saveState();
    render();
    setStatus("Unable to start the build job.");
  }
}

function startBuildPolling(chatId, jobId) {
  if (!jobId) {
    return;
  }

  const existing = jobPollers.get(jobId);
  if (existing) {
    return;
  }

  const poller = {
    stopped: false,
    failureCount: 0,
    timerId: null,
  };
  jobPollers.set(jobId, poller);

  const schedule = (delay = BUILD_POLL_INTERVAL_MS) => {
    if (poller.stopped) {
      return;
    }
    poller.timerId = window.setTimeout(tick, delay);
  };

  const stop = () => {
    poller.stopped = true;
    if (poller.timerId) {
      window.clearTimeout(poller.timerId);
    }
    jobPollers.delete(jobId);
  };

  const tick = async () => {
    const chat = findChatById(chatId);
    if (!chat) {
      stop();
      return;
    }

    try {
      const response = await fetch(`/api/build/status/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      const data = await readJsonResponse(response);
      poller.failureCount = 0;
      applyBuildStatus(chat, data);

      if (data.status === "queued" || data.status === "running") {
        schedule();
        return;
      }

      stop();
    } catch (error) {
      poller.failureCount += 1;
      if (poller.failureCount < 8) {
        setStatus("The build job is still running. Waiting for Render to answer...");
        schedule(Math.min(6000, BUILD_POLL_INTERVAL_MS * poller.failureCount));
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const pendingMessage = findOrCreateBuildMessage(chat);
      pendingMessage.content = `Build failed.\n\n${message}`;
      pendingMessage.stageLabel = "Error";
      chat.activeBuildJobId = "";
      chat.pendingBuildMessageId = "";
      chat.requestedArtifactKind = "";
      chat.updatedAt = Date.now();
      saveState();
      render();
      setStatus("The build job stopped responding.");
      stop();
    }
  };

  tick();
}

function applyBuildStatus(chat, data) {
  const pendingMessage = findOrCreateBuildMessage(chat);
  pendingMessage.stageLabel = formatBuildStage(data.stage, data.attempts);

  if (data.status === "queued" || data.status === "running") {
    pendingMessage.content =
      data.message || "Building the project, fixing errors, and preparing the downloads...";
    chat.activeBuildJobId = data.jobId || chat.activeBuildJobId;
    chat.updatedAt = Date.now();
    saveState();
    render();
    setStatus(pendingMessage.content);
    return;
  }

  if (data.status === "succeeded" && data.session) {
    pendingMessage.content = data.session.summary || "Build completed successfully.";
    pendingMessage.artifacts = Array.isArray(data.session.artifacts) ? data.session.artifacts : [];
    pendingMessage.stageLabel = "Complete";
    chat.latestBuild = data.session;
    chat.activeBuildJobId = "";
    chat.pendingBuildMessageId = "";
    const requestedKind = chat.requestedArtifactKind;
    chat.requestedArtifactKind = "";
    chat.updatedAt = Date.now();
    saveState();
    render();
    setStatus("Build finished and the downloads are ready.");

    const artifact = findArtifact(data.session, requestedKind);
    if (artifact) {
      triggerArtifactDownload(artifact);
      setStatus(`Downloaded ${artifact.name}.`);
    }
    return;
  }

  if (data.status === "failed") {
    pendingMessage.content = `Build failed.\n\n${data.error || data.details || "The build did not finish."}`;
    pendingMessage.artifacts = [];
    pendingMessage.stageLabel = "Error";
    chat.activeBuildJobId = "";
    chat.pendingBuildMessageId = "";
    chat.requestedArtifactKind = "";
    chat.updatedAt = Date.now();
    saveState();
    render();
    setStatus("The build failed.");
  }
}

function findOrCreateBuildMessage(chat) {
  let message = chat.messages.find((entry) => entry.id === chat.pendingBuildMessageId);
  if (message) {
    return message;
  }

  message = createMessage(
    "assistant",
    "Waiting for build progress...",
    { contextExcluded: true, stageLabel: "Queued" }
  );
  chat.messages.push(message);
  chat.pendingBuildMessageId = message.id;
  return message;
}

function findArtifact(session, kind) {
  if (!session || !Array.isArray(session.artifacts)) {
    return null;
  }
  return session.artifacts.find((artifact) => artifact.kind === kind) || null;
}

function triggerArtifactDownload(artifact) {
  if (!artifact?.downloadUrl) {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = artifact.downloadUrl;
  anchor.download = artifact.name || "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function resumePendingBuilds() {
  for (const chat of state.chats) {
    if (chat.activeBuildJobId) {
      startBuildPolling(chat.id, chat.activeBuildJobId);
    }
  }
}

function deriveChatTitle(chat) {
  const firstUserMessage = chat.messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "New Minecraft Project";
  }
  const normalized = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function setStatus(text) {
  currentStatus = text || "Ready.";
  elements.statusText.textContent = currentStatus;
}

function formatLoader(loader) {
  const labels = {
    auto: "Auto",
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
    paper: "Paper",
    spigot: "Spigot",
    bukkit: "Bukkit",
    velocity: "Velocity",
    datapack: "Datapack",
    "resource-pack": "Resource Pack",
  };
  return labels[normalizeLoader(loader)] || "Auto";
}

function formatHostLabel(hostingTarget) {
  const labels = {
    local: "Local server",
    render: "Render",
    vercel: "Vercel",
    netlify: "Netlify",
  };
  return labels[String(hostingTarget || "").toLowerCase()] || "Hosted server";
}

function formatBuildStage(stage, attempts) {
  const base = {
    queued: "Queued",
    starting: "Starting",
    generating: "Generating",
    preparing: "Preparing",
    building: "Building",
    repairing: "Repairing",
    packaging: "Packaging",
    complete: "Complete",
    failed: "Error",
  }[String(stage || "").toLowerCase()] || "Working";

  if ((stage === "building" || stage === "repairing") && attempts) {
    return `${base} • Attempt ${attempts}`;
  }
  return base;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(text);
  }
}

async function readResponseError(response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Request failed with HTTP ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.details || `Request failed with HTTP ${response.status}.`;
  } catch (_error) {
    return text;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
