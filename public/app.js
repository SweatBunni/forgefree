const STORAGE_KEY = "minecraft-codestral-studio-state-v4";

const elements = {
  chatList: document.getElementById("chatList"),
  chatCount: document.getElementById("chatCount"),
  messageThread: document.getElementById("messageThread"),
  messageTemplate: document.getElementById("messageTemplate"),
  promptInput: document.getElementById("promptInput"),
  composer: document.getElementById("composer"),
  sendButton: document.getElementById("sendButton"),
  loaderSelect: document.getElementById("loaderSelect"),
  versionInput: document.getElementById("versionInput"),
  newChatButton: document.getElementById("newChatButton"),
  buildJarButton: document.getElementById("buildJarButton"),
  downloadSourceButton: document.getElementById("downloadSourceButton"),
  actionStatus: document.getElementById("actionStatus"),
  apiStatus: document.getElementById("apiStatus"),
  welcomeState: document.getElementById("welcomeState"),
  temperatureInput: document.getElementById("temperatureInput"),
  temperatureValue: document.getElementById("temperatureValue"),
};

const state = loadState();
const runtime = {
  hostingTarget: "local",
  sourceExportSupported: true,
  jarBuildSupported: true,
  sessionBuildSupported: true,
};

renderChatList();
renderMessages();
syncControls();
attachEvents();
checkHealth();

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.chats) && parsed.chats.length > 0) {
        return {
          activeChatId: parsed.activeChatId || parsed.chats[0].id,
          chats: parsed.chats.map(normalizeChat),
          temperature: typeof parsed.temperature === "number" ? parsed.temperature : 0.2,
        };
      }
    } catch (_error) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  const firstChat = createChat("New Minecraft chat");
  return {
    activeChatId: firstChat.id,
    chats: [firstChat],
    temperature: 0.2,
  };
}

function normalizeChat(chat) {
  return {
    id: chat.id || crypto.randomUUID(),
    title: chat.title || "New Minecraft chat",
    createdAt: typeof chat.createdAt === "number" ? chat.createdAt : Date.now(),
    updatedAt: typeof chat.updatedAt === "number" ? chat.updatedAt : Date.now(),
    messages: Array.isArray(chat.messages)
      ? chat.messages.map((message) => ({
          role: message.role || "assistant",
          content: typeof message.content === "string" ? message.content : "",
          artifacts: Array.isArray(message.artifacts) ? message.artifacts : [],
        }))
      : [],
    preferences: normalizePreferences(chat.preferences),
    latestBuild: chat.latestBuild && Array.isArray(chat.latestBuild.artifacts) ? chat.latestBuild : null,
  };
}

function normalizePreferences(preferences) {
  const loader =
    typeof preferences?.loader === "string" && preferences.loader.trim()
      ? preferences.loader.trim()
      : "auto";
  const minecraftVersion =
    typeof preferences?.minecraftVersion === "string" && preferences.minecraftVersion.trim()
      ? preferences.minecraftVersion.trim()
      : "1.21.1";

  return {
    loader,
    minecraftVersion,
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createChat(title) {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    preferences: normalizePreferences(),
    latestBuild: null,
  };
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0];
}

function syncControls() {
  const activeChat = getActiveChat();
  elements.temperatureInput.value = String(state.temperature);
  elements.temperatureValue.textContent = Number(state.temperature).toFixed(1);
  elements.loaderSelect.value = activeChat.preferences.loader;
  elements.versionInput.value = activeChat.preferences.minecraftVersion;
}

function renderChatList() {
  const activeChat = getActiveChat();
  elements.chatList.innerHTML = "";
  elements.chatCount.textContent = String(state.chats.length);

  if (state.chats.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No chats yet.";
    elements.chatList.appendChild(empty);
    return;
  }

  for (const chat of [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-item${chat.id === activeChat.id ? " active" : ""}`;
    button.innerHTML = `
      <span class="chat-item-title">${escapeHtml(chat.title)}</span>
      <span class="chat-item-meta">
        <span>${chat.messages.length} messages</span>
        <span>${formatDate(chat.updatedAt)}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      state.activeChatId = chat.id;
      saveState();
      renderChatList();
      renderMessages();
      syncControls();
      setActionStatus("Download the latest fixed JAR or source ZIP from this chat.");
    });
    elements.chatList.appendChild(button);
  }
}

function renderMessages() {
  const activeChat = getActiveChat();
  elements.messageThread.innerHTML = "";
  const hasMessages = activeChat.messages.length > 0;

  elements.welcomeState.classList.toggle("hidden", hasMessages);
  elements.messageThread.classList.toggle("hidden", !hasMessages);

  for (const message of activeChat.messages) {
    const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    node.querySelector(".role-badge").textContent = message.role;
    const copyButton = node.querySelector(".copy-button");
    const body = node.querySelector(".message-body");
    body.innerHTML = renderMarkdown(message.content);

    if (Array.isArray(message.artifacts) && message.artifacts.length > 0) {
      body.appendChild(renderArtifactList(message.artifacts));
    }

    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.content);
      copyButton.textContent = "Copied";
      window.setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1200);
    });
    elements.messageThread.appendChild(node);
  }

  elements.messageThread.scrollTop = elements.messageThread.scrollHeight;
}

function renderArtifactList(artifacts) {
  const wrapper = document.createElement("div");
  wrapper.className = "artifact-list";

  for (const artifact of artifacts) {
    const card = document.createElement("div");
    card.className = "artifact-card";

    const label = document.createElement("div");
    label.className = "artifact-meta";
    label.innerHTML = `
      <strong>${escapeHtml(artifact.kind === "jar" ? "Fixed JAR" : "Fixed Source ZIP")}</strong>
      <span>${escapeHtml(artifact.name || "")}</span>
    `;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifact-button";
    button.textContent = artifact.kind === "jar" ? "Download JAR" : "Download Source";
    button.addEventListener("click", () => {
      downloadArtifact(artifact);
    });

    card.append(label, button);
    wrapper.appendChild(card);
  }

  return wrapper;
}

function attachEvents() {
  elements.newChatButton.addEventListener("click", createNewChat);

  elements.temperatureInput.addEventListener("input", (event) => {
    state.temperature = Number(event.target.value);
    elements.temperatureValue.textContent = state.temperature.toFixed(1);
    saveState();
  });

  elements.loaderSelect.addEventListener("change", () => {
    const activeChat = getActiveChat();
    activeChat.preferences.loader = elements.loaderSelect.value;
    activeChat.latestBuild = null;
    saveState();
  });

  elements.versionInput.addEventListener("change", () => {
    const activeChat = getActiveChat();
    activeChat.preferences.minecraftVersion = (elements.versionInput.value || "1.21.1").trim() || "1.21.1";
    activeChat.latestBuild = null;
    saveState();
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendPrompt();
  });

  elements.promptInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendPrompt();
    }
  });

  elements.buildJarButton.addEventListener("click", async () => {
    await runProjectAction("jar");
  });

  elements.downloadSourceButton.addEventListener("click", async () => {
    await runProjectAction("source");
  });

  document.querySelectorAll(".suggestion-chip").forEach((button) => {
    button.addEventListener("click", () => {
      elements.promptInput.value = button.dataset.prompt || "";
      elements.promptInput.focus();
    });
  });
}

function createNewChat() {
  const chat = createChat("New Minecraft chat");
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  saveState();
  renderChatList();
  renderMessages();
  syncControls();
  setActionStatus("Started a fresh chat.");
  elements.promptInput.focus();
}

async function sendPrompt() {
  const prompt = elements.promptInput.value.trim();
  if (!prompt) {
    return;
  }

  const activeChat = getActiveChat();
  const userMessage = { role: "user", content: prompt, artifacts: [] };
  activeChat.messages.push(userMessage);
  activeChat.latestBuild = null;
  activeChat.updatedAt = Date.now();
  if (activeChat.title === "New Minecraft chat" || activeChat.messages.length === 1) {
    activeChat.title = prompt.slice(0, 48);
  }

  elements.promptInput.value = "";
  setComposerBusy(true);
  saveState();
  renderChatList();
  renderMessages();

  const placeholder = {
    role: "assistant",
    content: "Thinking through the Minecraft code request...",
    artifacts: [],
  };
  activeChat.messages.push(placeholder);
  renderMessages();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        temperature: state.temperature,
        preferences: activeChat.preferences,
        messages: activeChat.messages
          .filter((message) => message !== placeholder)
          .map((message) => ({ role: message.role, content: message.content })),
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    const data = await readJsonResponse(response);

    placeholder.content = data.content || "No response content returned.";
    activeChat.updatedAt = Date.now();
    setActionStatus("Chat updated. Build the project when you're ready to fix and download it.");
  } catch (error) {
    placeholder.content =
      `Request failed.\n\n${error instanceof Error ? error.message : String(error)}\n\n` +
      getHostedApiKeyHint();
    setActionStatus("The chat request failed.");
  } finally {
    saveState();
    renderChatList();
    renderMessages();
    setComposerBusy(false);
  }
}

async function runProjectAction(kind) {
  const activeChat = getActiveChat();
  const hasUserMessages = activeChat.messages.some((message) => message.role === "user");

  if (!hasUserMessages) {
    setActionStatus("Ask for a mod or plugin first so there is something to build.");
    return;
  }

  if (!runtime.sessionBuildSupported) {
    await downloadDirectArtifact(kind);
    return;
  }

  const latestArtifact = getLatestArtifact(activeChat, kind);
  if (latestArtifact) {
    downloadArtifact(latestArtifact);
    setActionStatus(
      kind === "jar"
        ? `Downloading ${latestArtifact.name} from the latest fixed build.`
        : `Downloading ${latestArtifact.name} from the latest fixed build.`
    );
    return;
  }

  await buildAndPublishArtifacts(kind);
}

async function downloadDirectArtifact(kind) {
  const activeChat = getActiveChat();
  const endpoint = kind === "jar" ? "/api/export/jar" : "/api/export/source";
  const buttonStates = [
    { button: elements.buildJarButton, busy: "Preparing JAR...", idle: "Download JAR" },
    { button: elements.downloadSourceButton, busy: "Preparing Source...", idle: "Download Source" },
  ];

  for (const stateEntry of buttonStates) {
    setButtonBusy(stateEntry.button, true, stateEntry.busy);
  }

  const placeholder = {
    role: "assistant",
    content:
      kind === "jar"
        ? "Preparing a downloadable JAR from this chat..."
        : "Packaging a downloadable source ZIP from this chat...",
    artifacts: [],
  };

  activeChat.messages.push(placeholder);
  activeChat.updatedAt = Date.now();
  saveState();
  renderChatList();
  renderMessages();
  setActionStatus(
    kind === "jar"
      ? "Preparing a downloadable JAR from the current chat."
      : "Preparing a downloadable source ZIP from the current chat."
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        temperature: state.temperature,
        preferences: activeChat.preferences,
        messages: activeChat.messages
          .filter((message) => message !== placeholder)
          .map((message) => ({ role: message.role, content: message.content })),
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    const blob = await response.blob();
    const downloadName = extractDownloadName(response, kind);
    triggerBlobDownload(blob, downloadName);

    placeholder.content =
      kind === "jar"
        ? `Built the JAR and started the download for \`${downloadName}\`.`
        : `Prepared the source ZIP and started the download for \`${downloadName}\`.`;
    activeChat.updatedAt = Date.now();
    saveState();
    renderChatList();
    renderMessages();
    setActionStatus(`Downloaded ${downloadName}.`);
  } catch (error) {
    placeholder.content = `Download failed.\n\n${error instanceof Error ? error.message : String(error)}`;
    saveState();
    renderChatList();
    renderMessages();
    setActionStatus("The hosted download request failed.");
  } finally {
    for (const stateEntry of buttonStates) {
      setButtonBusy(stateEntry.button, false, stateEntry.idle);
    }
  }
}

async function buildAndPublishArtifacts(kindToDownload) {
  const activeChat = getActiveChat();
  const buttonStates = [
    { button: elements.buildJarButton, busy: "Fixing + Building...", idle: "Download JAR" },
    { button: elements.downloadSourceButton, busy: "Fixing + Packaging...", idle: "Download Source" },
  ];
  for (const stateEntry of buttonStates) {
    setButtonBusy(stateEntry.button, true, stateEntry.busy);
  }

  const placeholder = {
    role: "assistant",
    content:
      "Building the project, reading the build logs, fixing errors, and preparing the final downloads...",
    artifacts: [],
  };

  activeChat.messages.push(placeholder);
  activeChat.updatedAt = Date.now();
  saveState();
  renderChatList();
  renderMessages();
  setActionStatus("ForgefreeAI is building the project, fixing errors, and preparing downloads.");

  try {
    const response = await fetch("/api/build/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        temperature: state.temperature,
        preferences: activeChat.preferences,
        messages: activeChat.messages
          .filter((message) => message !== placeholder)
          .map((message) => ({ role: message.role, content: message.content })),
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    const data = await readJsonResponse(response);

    activeChat.latestBuild = data;
    placeholder.content = data.summary || "Build completed successfully.";
    placeholder.artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
    activeChat.updatedAt = Date.now();
    saveState();
    renderChatList();
    renderMessages();

    const requestedArtifact = getLatestArtifact(activeChat, kindToDownload);
    if (requestedArtifact) {
      downloadArtifact(requestedArtifact);
      setActionStatus(`Built, fixed, and downloaded ${requestedArtifact.name}.`);
    } else {
      setActionStatus("Build completed, but the requested download was not found.");
    }
  } catch (error) {
    placeholder.content = `Build failed.\n\n${error instanceof Error ? error.message : String(error)}`;
    placeholder.artifacts = [];
    activeChat.latestBuild = null;
    saveState();
    renderChatList();
    renderMessages();
    setActionStatus("The build/fix loop failed.");
  } finally {
    for (const stateEntry of buttonStates) {
      setButtonBusy(stateEntry.button, false, stateEntry.idle);
    }
  }
}

function getLatestArtifact(chat, kind) {
  if (!chat.latestBuild || !Array.isArray(chat.latestBuild.artifacts)) {
    return null;
  }

  return chat.latestBuild.artifacts.find((artifact) => artifact.kind === kind) || null;
}

function downloadArtifact(artifact) {
  const anchor = document.createElement("a");
  anchor.href = artifact.downloadUrl;
  anchor.download = artifact.name || "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function setComposerBusy(isBusy) {
  elements.sendButton.disabled = isBusy;
  elements.sendButton.textContent = isBusy ? "Thinking..." : "Send";
}

function setButtonBusy(button, isBusy, label) {
  button.disabled = isBusy;
  button.textContent = label;
}

function setActionStatus(message) {
  elements.actionStatus.textContent = message;
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await readJsonResponse(response);
    runtime.hostingTarget = data.hostingTarget || "local";
    runtime.sourceExportSupported = data.sourceExportSupported !== false;
    runtime.jarBuildSupported = Boolean(data.jarBuildSupported);
    runtime.sessionBuildSupported = Boolean(data.sessionBuildSupported);
    const javaLabel = data.javaAvailable ? "Java ready" : "Java missing";
    elements.apiStatus.textContent = data.apiKeyConfigured
      ? `Ready: ${data.model} - ${javaLabel}`
      : `Missing API key - ${javaLabel}`;

    if (runtime.hostingTarget !== "local") {
      setActionStatus(
        runtime.sessionBuildSupported
          ? "Hosted mode is active."
          : `${formatHostingLabel(runtime.hostingTarget)} hosted mode is active. Downloads use direct export builds here instead of persistent build sessions.`
      );
    }
  } catch (_error) {
    elements.apiStatus.textContent = "Server offline";
  }
}

function formatHostingLabel(hostingTarget) {
  if (hostingTarget === "vercel") {
    return "Vercel";
  }
  if (hostingTarget === "netlify") {
    return "Netlify";
  }
  if (hostingTarget === "render") {
    return "Render";
  }
  return "Hosted";
}

async function readResponseError(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await readJsonResponse(response);
    return formatErrorPayload(
      data,
      `Request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`
    );
  }

  const text = (await response.text()).trim();
  if (text) {
    return text;
  }

  return `Request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
}

function formatErrorPayload(data, fallbackMessage) {
  if (!data || typeof data !== "object") {
    return fallbackMessage;
  }

  const errorText =
    typeof data.error === "string" && data.error.trim() ? data.error.trim() : "";
  const detailsText =
    typeof data.details === "string" && data.details.trim() ? data.details.trim() : "";

  if (errorText && detailsText && detailsText !== errorText) {
    return `${errorText}\n\n${detailsText}`;
  }

  return errorText || detailsText || fallbackMessage;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(text.slice(0, 300).trim() || "The server returned an invalid JSON response.");
  }
}

function getHostedApiKeyHint() {
  if (runtime.hostingTarget === "vercel") {
    return "Add your Mistral API key to the Vercel environment variables and redeploy.";
  }
  if (runtime.hostingTarget === "netlify") {
    return "Add your Mistral API key to the Netlify environment variables and redeploy.";
  }
  return "Add your Mistral API key to minecraft-codestral-studio/.env and try again.";
}

function extractDownloadName(response, kind) {
  const header = response.headers.get("content-disposition") || "";
  const match = header.match(/filename="?([^";]+)"?/i);
  if (match?.[1]) {
    return match[1];
  }

  return kind === "jar" ? "forgefreeai-build.jar" : "forgefreeai-source.zip";
}

function triggerBlobDownload(blob, downloadName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(markdown) {
  const codeBlocks = [];
  let working = String(markdown).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const token = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(
      `<pre><code class="language-${escapeHtml(language || "plain")}">${escapeHtml(code)}</code></pre>`
    );
    return token;
  });

  working = escapeHtml(working)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const paragraphs = working
    .split(/\n{2,}/)
    .map((section) => `<p>${section.replace(/\n/g, "<br>")}</p>`)
    .join("");

  return codeBlocks.reduce(
    (html, block, index) => html.replace(`__CODE_BLOCK_${index}__`, block),
    paragraphs
  );
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}
