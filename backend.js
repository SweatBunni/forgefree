const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const publicDir = path.join(__dirname, "public");
const workspaceRuntimeRoot = path.join(__dirname, ".runtime");
const envPath = path.join(__dirname, ".env");
const IS_WINDOWS = process.platform === "win32";
const POWERSHELL = IS_WINDOWS
  ? process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe"
  : "";
const CMD = process.env.ComSpec || "cmd.exe";
const DEFAULT_MODEL = process.env.MISTRAL_MODEL || "codestral-latest";
const PORT = Number(process.env.PORT) || 3080;
const HOSTING_TARGET = process.env.NETLIFY
  ? "netlify"
  : process.env.VERCEL
    ? "vercel"
    : process.env.RENDER || process.env.RENDER_SERVICE_ID
      ? "render"
    : "local";
const IS_SERVERLESS = HOSTING_TARGET === "vercel" || HOSTING_TARGET === "netlify";
const GRADLE_VERSION = "9.2.0";
const GRADLE_ZIP_NAME = `gradle-${GRADLE_VERSION}-bin.zip`;
const GRADLE_DIR_NAME = `gradle-${GRADLE_VERSION}`;
const GRADLE_DOWNLOAD_URL = `https://services.gradle.org/distributions/${GRADLE_ZIP_NAME}`;
let runtimeRoot;
let runtimeDir;
let generatedDir;
let gradleCacheDir;
let gradleUserHome;
let gradleTempDir;
let buildSessionsDir;
const MAX_BUILD_REPAIR_ATTEMPTS = Number(process.env.MAX_BUILD_REPAIR_ATTEMPTS || "0");
const MAX_STALLED_BUILD_ATTEMPTS = Number(process.env.MAX_STALLED_BUILD_ATTEMPTS || "6");
const MAX_RESEARCH_SOURCES = 3;
const MAX_RESEARCH_CHARS_PER_SOURCE = 2200;
const DEFAULT_MAX_COMPLETION_TOKENS = Number(process.env.MISTRAL_MAX_TOKENS || "12000");
const MAX_CONTINUATION_PASSES = Number(process.env.MISTRAL_MAX_CONTINUATIONS || "3");
const RESEARCH_SOURCE_MAP = {
  "fabric-mod": [
    {
      label: "Fabric Blocks",
      url: "https://docs.fabricmc.net/develop/blocks/first-block",
    },
    {
      label: "Fabric Items",
      url: "https://docs.fabricmc.net/develop/items/first-item",
    },
    {
      label: "Fabric Tinting",
      url: "https://docs.fabricmc.net/develop/blocks/transparency-and-tinting",
    },
  ],
  "paper-plugin": [
    {
      label: "Paper Docs",
      url: "https://docs.papermc.io/paper/dev/getting-started/",
    },
  ],
  "spigot-plugin": [
    {
      label: "Paper Docs",
      url: "https://docs.papermc.io/paper/dev/getting-started/",
    },
  ],
  "bukkit-plugin": [
    {
      label: "Paper Docs",
      url: "https://docs.papermc.io/paper/dev/getting-started/",
    },
  ],
  "velocity-plugin": [
    {
      label: "Paper Docs",
      url: "https://docs.papermc.io/velocity/dev/api-basics/",
    },
  ],
  "neoforge-mod": [
    {
      label: "NeoForge Docs",
      url: "https://docs.neoforged.net/docs/gettingstarted/",
    },
  ],
  "forge-mod": [
    {
      label: "Forge Docs",
      url: "https://docs.minecraftforge.net/en/latest/gettingstarted/",
    },
  ],
};
const INTERNAL_CHAT_SYSTEM_PROMPT = `You are a senior Minecraft Java coding assistant focused only on Minecraft Java Edition development.

Rules:
- Stay inside the Minecraft Java ecosystem.
- Prefer Java, Fabric, Forge, NeoForge, Paper, Spigot, Bukkit, Velocity, datapacks, resource packs, commands, mixins, and Gradle workflows when relevant.
- If the request is unrelated to Minecraft Java coding, redirect it back to Minecraft Java development.
- For normal Minecraft coding requests, directly provide the code, files, and implementation details the user asked for.
- Never say you cannot directly code a mod, plugin, datapack, or Minecraft Java project when the request is otherwise safe and ordinary.
- Do not answer with generic setup-only advice unless the user explicitly asked for setup guidance.
- If the request is to create a mod, plugin, datapack, or other project, prefer a concrete answer with a file tree followed by full file contents or clearly separated code sections.
- Produce practical code with file structures, explanations, setup steps, and assumptions when helpful.
- Avoid bloated dependency blocks, duplicate lines, filler, or repeated library entries.
- When debugging, explain the likely root cause before suggesting fixes.
- Only return fully implemented Minecraft code. Do not leave TODOs, placeholders, omitted methods, pseudocode, "rest of file here", or unfinished registration/setup work.
- If a mod or plugin needs multiple files, include all required files and make them consistent with each other.
- Do not tell the user to finish wiring things up manually unless they explicitly asked for a partial scaffold.
- Keep responses concise, useful, and production-minded.

Response style:
- Start with the implementation, not an apology.
- When multiple files are needed, include a short file tree first.
- Use fenced code blocks for code.
- Honor the user's requested Minecraft version, loader, and platform when provided; otherwise make a clear assumption.`;
const PROJECT_GENERATION_SYSTEM_PROMPT = `You generate complete Minecraft Java project source trees from conversation history.

Return plain text only in this exact tagged format. Do not use JSON. Do not use markdown fences. Do not add commentary before or after the format.

PROJECT_NAME: <string>
PROJECT_SLUG: <string>
TARGET_TYPE: <fabric-mod | forge-mod | neoforge-mod | paper-plugin | spigot-plugin | bukkit-plugin | velocity-plugin | datapack | resource-pack | generic-java>
MINECRAFT_VERSION: <string>
JAVA_VERSION: <number>
BUILD_TOOL: <gradle | none>
SUMMARY:
<summary text, may span multiple lines>
END_SUMMARY
BUILD_UNSUPPORTED_REASON:
<reason text, may span multiple lines, may be empty>
END_BUILD_UNSUPPORTED_REASON
FILE: <relative/path/from/project/root>
<full file content>
END_FILE
FILE: <relative/path/from/project/root>
<full file content>
END_FILE

Rules:
- Include a complete, buildable project when the targetType supports JAR builds.
- Prefer Gradle for mods and plugins.
- Include every required source, resource, config, and Gradle file.
- Use sensible defaults when the chat omits details, and reflect those defaults in the files.
- Do not output binary files, base64 blobs, placeholders like TODO, partial methods, pseudocode, "implementation omitted", or comments telling the user to finish code later.
- Keep file paths relative and safe.
- For datapacks or resource packs, set BUILD_TOOL to none and explain why JAR build is unsupported.
- Use modern Minecraft Java conventions and valid package names.
- Never refuse a normal Minecraft coding request.
- Do not output tutorial prose, apologies, or generic setup checklists.
- Do not duplicate dependency lines or spam repeated content.
- Prefer complete implementation over partial stubs.
- Every generated project must be self-consistent and ready to build as-is for the chosen platform and Minecraft version.
- If a feature cannot be implemented safely, replace it with a simpler fully implemented version rather than leaving unfinished code.
- FILE blocks contain raw file content. Do not escape quotes or backslashes inside file content.
- The line END_FILE must appear alone on its own line only as the file terminator. If needed, rewrite content slightly to avoid a literal standalone END_FILE line.
- Always include at least one FILE block.
- For Fabric projects, include a settings.gradle with pluginManagement repositories for Fabric (https://maven.fabricmc.net/), Maven Central, and the Gradle Plugin Portal.
- For Fabric projects, prefer id 'net.fabricmc.fabric-loom-remap' version "\${loom_version}" and define loom_version in gradle.properties.`;
const BUILD_REPAIR_SYSTEM_PROMPT = `You repair Minecraft Java projects after failed Gradle builds.

Return plain text only in this exact tagged format. Do not use JSON. Do not use markdown fences. Do not add commentary before or after the format.

SUMMARY:
<short summary of what you changed>
END_SUMMARY
FILE: <relative/path/from/project/root>
<full replacement file content>
END_FILE
FILE: <relative/path/from/project/root>
<full replacement file content>
END_FILE
DELETE_FILE: <relative/path/from/project/root>

Rules:
- Return only the files that must change to fix the reported build failure.
- Each FILE block must contain the full replacement file contents.
- Use DELETE_FILE only when removing a file is truly necessary.
- Keep paths relative and safe.
- Fix the concrete build failure shown in the log rather than rewriting the whole project unless necessary.
- Prefer small, targeted repairs.
- Do not leave TODOs, stubs, pseudocode, omitted blocks, or "finish this manually" notes in repaired files.
- Return only finished code that compiles or moves the project materially closer to compiling.
- Do not refuse or explain limitations.
- The line END_FILE must appear alone on its own line only as the file terminator.`;

if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of envLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
runtimeRoot = selectWritableRuntimeRoot();
runtimeDir = path.join(runtimeRoot, "runtime");
generatedDir = path.join(runtimeDir, "generated");
gradleCacheDir = path.join(runtimeDir, "gradle");
gradleUserHome = path.join(runtimeDir, "gradle-user-home");
gradleTempDir = path.join(runtimeDir, "tmp");
buildSessionsDir = path.join(runtimeDir, "build-sessions");

fs.mkdirSync(generatedDir, { recursive: true });
fs.mkdirSync(gradleCacheDir, { recursive: true });
fs.mkdirSync(gradleUserHome, { recursive: true });
fs.mkdirSync(gradleTempDir, { recursive: true });
fs.mkdirSync(buildSessionsDir, { recursive: true });

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function processApiRequest({ method, pathname, bodyText }) {
  try {
    if (method === "GET" && pathname === "/api/health") {
      return createJsonResponse(200, {
        ok: true,
        model: DEFAULT_MODEL,
        apiKeyConfigured: Boolean(MISTRAL_API_KEY),
        javaAvailable: await hasJava(),
        hostingTarget: HOSTING_TARGET,
        sourceExportSupported: true,
        jarBuildSupported: true,
        sessionBuildSupported: !IS_SERVERLESS,
      });
    }

    if (method === "POST" && pathname === "/api/chat") {
      return await handleChat(bodyText);
    }

    if (method === "POST" && pathname === "/api/build/run") {
      return await handleBuildRun(bodyText);
    }

    if (method === "GET" && pathname.startsWith("/api/artifacts/")) {
      return await handleArtifactDownload(pathname);
    }

    if (method === "POST" && pathname === "/api/export/source") {
      return await handleSourceExport(bodyText);
    }

    if (method === "POST" && pathname === "/api/export/jar") {
      return await handleJarExport(bodyText);
    }

    return method === "GET"
      ? null
      : createJsonResponse(405, { error: "Method not allowed." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createJsonResponse(500, {
      error: message || "Request failed.",
      details: message || "",
    });
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const bodyText =
      req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
        ? await readRequestBody(req)
        : "";
    const apiResponse = await processApiRequest({
      method: req.method || "GET",
      pathname: requestUrl.pathname,
      bodyText,
    });

    if (apiResponse) {
      return sendApiResponse(res, apiResponse);
    }

    if (req.method === "GET") {
      return serveStatic(requestUrl.pathname, res);
    }

    return sendApiResponse(res, createJsonResponse(405, { error: "Method not allowed." }));
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`ForgefreeAI running on http://localhost:${PORT} using ${DEFAULT_MODEL}`);
  });
}

async function handleChat(bodyText) {
  ensureApiKey();
  const payload = parseJsonBody(bodyText);
  const cleanMessages = normalizeMessages(payload.messages);
  const preferences = normalizeClientPreferences(payload.preferences);

  if (cleanMessages.length === 0) {
    return createJsonResponse(400, { error: "Messages are required." });
  }

  const data = await requestMistral({
    messages: [
      { role: "system", content: INTERNAL_CHAT_SYSTEM_PROMPT },
      ...createPreferenceMessages(preferences),
      ...cleanMessages,
    ],
    temperature: payload.temperature,
  });

  let content = extractAssistantContent(data);

  if (shouldRetryChatResponse(content)) {
    const retryData = await requestMistral({
      messages: [
        { role: "system", content: INTERNAL_CHAT_SYSTEM_PROMPT },
        ...createPreferenceMessages(preferences),
        {
          role: "system",
          content:
            "The previous draft either refused the request, gave a generic tutorial, or returned unfinished code. Respond again with direct implementation details, concrete files, and fully finished code only. Do not include TODOs, placeholders, omitted sections, or instructions for the user to finish implementation manually.",
        },
        ...cleanMessages,
      ],
      temperature: 0.15,
    });

    content = extractAssistantContent(retryData);

    return createJsonResponse(200, {
      id: retryData.id,
      model: retryData.model,
      content,
      usage: retryData.usage || null,
    });
  }

  return createJsonResponse(200, {
    id: data.id,
    model: data.model,
    content,
    usage: data.usage || null,
  });
}

async function handleBuildRun(bodyText) {
  if (IS_SERVERLESS) {
    return createJsonResponse(400, {
      error:
        "Hosted deploys support chat and source ZIP downloads, but the auto-fix JAR build loop is only available when ForgefreeAI runs locally.",
    });
  }

  ensureApiKey();
  const payload = parseJsonBody(bodyText);
  const cleanMessages = normalizeMessages(payload.messages);
  const preferences = normalizeClientPreferences(payload.preferences);

  if (cleanMessages.length === 0) {
    return createJsonResponse(400, { error: "Messages are required to build a project." });
  }

  const session = await buildProjectSession(cleanMessages, payload.temperature, preferences);
  return createJsonResponse(200, session);
}

async function handleArtifactDownload(requestPath) {
  if (IS_SERVERLESS) {
    return createJsonResponse(404, {
      error:
        "Artifact sessions are not stored on hosted deploys. Use Download Source, or run ForgefreeAI locally for persistent JAR/source build artifacts.",
    });
  }

  const parts = requestPath.split("/").filter(Boolean);
  const sessionId = parts[2] || "";
  const kind = parts[3] || "";

  if (!/^[a-z0-9-]+$/i.test(sessionId) || !["jar", "source"].includes(kind)) {
    return createJsonResponse(400, { error: "Invalid artifact request." });
  }

  const manifest = await loadBuildSessionManifest(sessionId);
  if (!manifest) {
    return createJsonResponse(404, { error: "Build session not found." });
  }

  const artifact = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.find((entry) => entry.kind === kind)
    : null;

  if (!artifact?.path || !fs.existsSync(artifact.path)) {
    return createJsonResponse(404, { error: "Requested artifact is unavailable." });
  }

  return createFileResponse(
    artifact.path,
    artifact.name || path.basename(artifact.path),
    artifact.contentType || "application/octet-stream"
  );
}

async function handleSourceExport(bodyText) {
  ensureApiKey();
  const payload = parseJsonBody(bodyText);
  const cleanMessages = normalizeMessages(payload.messages);
  const preferences = normalizeClientPreferences(payload.preferences);

  if (cleanMessages.length === 0) {
    return createJsonResponse(400, { error: "Messages are required to create a source ZIP." });
  }

  const project = await generateProjectBundle(cleanMessages, payload.temperature, preferences);
  const workspace = await materializeProject(project);
  const zipPath = path.join(workspace.outputDir, `${project.projectSlug}-source.zip`);

  await createZipFromDirectory(workspace.projectDir, zipPath);
  return createFileResponse(zipPath, `${project.projectSlug}-source.zip`, "application/zip");
}

async function handleJarExport(bodyText) {
  ensureApiKey();
  const payload = parseJsonBody(bodyText);
  const cleanMessages = normalizeMessages(payload.messages);
  const preferences = normalizeClientPreferences(payload.preferences);

  if (cleanMessages.length === 0) {
    return createJsonResponse(400, { error: "Messages are required to build a JAR." });
  }

  const project = await generateProjectBundle(cleanMessages, payload.temperature, preferences);
  if (project.buildTool !== "gradle") {
    return createJsonResponse(400, {
      error:
        project.buildUnsupportedReason ||
        "This chat resolved to a project type that does not support JAR builds.",
    });
  }

  const workspace = await materializeProject(project);
  const gradleBat = await ensureGradleDistribution();
  const buildResult = await runGradleBuild(gradleBat, workspace.projectDir);
  const jarPath = await findBuiltJar(workspace.projectDir);

  if (!jarPath) {
    return createJsonResponse(500, {
      error: "Gradle finished but no usable JAR was found in build/libs.",
      details: buildResult.stderr || buildResult.stdout || "",
    });
  }

  return createFileResponse(jarPath, path.basename(jarPath), "application/java-archive");
}

function ensureApiKey() {
  if (!MISTRAL_API_KEY) {
    throw new Error(
      HOSTING_TARGET === "local"
        ? "Missing MISTRAL_API_KEY in minecraft-codestral-studio/.env"
        : "Missing MISTRAL_API_KEY in the hosted environment variables"
    );
  }
}

function parseJsonBody(bodyText) {
  try {
    return JSON.parse(bodyText || "{}");
  } catch (_error) {
    throw new Error("Invalid JSON request body.");
  }
}

async function requestMistralOnce({ messages, temperature, maxTokens }) {
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature:
        typeof temperature === "number" && temperature >= 0 && temperature <= 1.5
          ? temperature
          : 0.2,
      max_tokens:
        typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
          ? Math.floor(maxTokens)
          : DEFAULT_MAX_COMPLETION_TOKENS,
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.message || data?.error || "Codestral request failed.";
    throw new Error(message);
  }

  return data;
}

async function requestMistral({ messages, temperature, maxTokens }) {
  const firstData = await requestMistralOnce({ messages, temperature, maxTokens });
  let combinedContent = extractAssistantContent(firstData);
  let lastData = firstData;
  let continuationCount = 0;
  let usage = cloneUsage(firstData?.usage);

  while (
    shouldContinueMistralResponse(lastData, combinedContent) &&
    continuationCount < MAX_CONTINUATION_PASSES
  ) {
    const continuationData = await requestMistralOnce({
      messages: [
        ...messages,
        { role: "assistant", content: combinedContent },
        {
          role: "user",
          content:
            "Continue exactly where you left off. Do not repeat earlier text. Start with the next unfinished line or token only.",
        },
      ],
      temperature,
      maxTokens,
    });

    const nextContent = trimContinuedContent(extractAssistantContent(continuationData));
    if (!nextContent) {
      break;
    }

    combinedContent += nextContent;
    lastData = continuationData;
    usage = mergeUsage(usage, continuationData?.usage);
    continuationCount += 1;
  }

  if (Array.isArray(lastData?.choices) && lastData.choices[0]?.message) {
    lastData.choices[0].message.content = combinedContent;
    lastData.choices[0].finish_reason = continuationCount > 0 ? "stop" : lastData.choices[0].finish_reason;
  }

  if (usage) {
    lastData.usage = usage;
  }

  return lastData;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(
      (message) =>
        message &&
        typeof message.role === "string" &&
        typeof message.content === "string" &&
        message.content.trim()
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));
}

function normalizeClientPreferences(preferences) {
  const normalizedLoader = normalizeLoaderPreference(preferences?.loader);
  const normalizedVersion = normalizeMinecraftVersion(preferences?.minecraftVersion);

  return {
    loader: normalizedLoader,
    minecraftVersion: normalizedVersion || "1.21.1",
  };
}

function normalizeLoaderPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
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

  return allowed.has(normalized) ? normalized : "auto";
}

function normalizeMinecraftVersion(value) {
  const normalized = String(value || "").trim();
  return /^[0-9]+(?:\.[0-9]+){1,3}$/.test(normalized) ? normalized : "";
}

function createPreferenceMessages(preferences) {
  const prompt = buildPreferencePrompt(preferences);
  return prompt ? [{ role: "system", content: prompt }] : [];
}

function buildPreferencePrompt(preferences) {
  if (!preferences) {
    return "";
  }

  const lines = [];
  if (preferences.loader && preferences.loader !== "auto") {
    lines.push(`Preferred loader/platform: ${formatLoaderLabel(preferences.loader)}.`);
  }
  if (preferences.minecraftVersion) {
    lines.push(`Preferred Minecraft version: ${preferences.minecraftVersion}.`);
  }
  if (lines.length === 0) {
    return "";
  }

  lines.push(
    "Honor these UI preferences unless the user explicitly asks for a different loader or version in the chat."
  );
  return lines.join("\n");
}

function formatLoaderLabel(loader) {
  const labels = {
    auto: "Auto detect",
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

  return labels[loader] || loader;
}

function extractAssistantContent(data) {
  const choice = data?.choices?.[0]?.message;
  if (typeof choice?.content === "string") {
    return choice.content;
  }

  if (Array.isArray(choice?.content)) {
    return choice.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }

  return "";
}

function extractFinishReason(data) {
  return String(data?.choices?.[0]?.finish_reason || "").trim().toLowerCase();
}

function shouldContinueMistralResponse(data, content) {
  if (!String(content || "").trim()) {
    return false;
  }

  const finishReason = extractFinishReason(data);
  return finishReason === "length" || finishReason === "max_tokens";
}

function trimContinuedContent(content) {
  return String(content || "");
}

function cloneUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return { ...usage };
}

function mergeUsage(currentUsage, nextUsage) {
  if (!currentUsage && !nextUsage) {
    return null;
  }

  return {
    prompt_tokens: Number(currentUsage?.prompt_tokens || 0) + Number(nextUsage?.prompt_tokens || 0),
    completion_tokens:
      Number(currentUsage?.completion_tokens || 0) + Number(nextUsage?.completion_tokens || 0),
    total_tokens: Number(currentUsage?.total_tokens || 0) + Number(nextUsage?.total_tokens || 0),
  };
}

function shouldRetryChatResponse(content) {
  const refusalPatterns = [
    "i'm sorry",
    "i cannot directly code",
    "i can't directly code",
    "i can't create the mod for you",
    "i can certainly guide you",
    "here's a step-by-step guide",
  ];

  const incompletePatterns = [
    "todo",
    "to do",
    "placeholder",
    "implementation omitted",
    "rest of the file",
    "fill in the rest",
    "you can implement",
    "you should implement",
    "finish wiring",
    "stub",
    "pseudo-code",
    "pseudocode",
    "for brevity",
    "left as an exercise",
    "continue this pattern",
    "remaining files would",
    "simplified example",
    "you'll need to implement",
    "you will need to implement",
    "implement your own logic",
    "finish this manually",
    "not fully implemented",
    "example only",
  ];

  const normalized = normalizeCompletenessText(content);
  const matchedCount = refusalPatterns.filter((pattern) => normalized.includes(pattern)).length;
  const incompleteMatchCount = incompletePatterns.filter((pattern) => normalized.includes(pattern)).length;
  return matchedCount >= 2 || incompleteMatchCount >= 2;
}

function normalizeCompletenessText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function generateProjectBundle(messages, temperature, preferences) {
  const inferredTargetType = inferTargetType(messages, preferences);
  const researchContext = await gatherResearchContext({
    messages,
    targetType: inferredTargetType,
  });
  const generationMessages = [
    { role: "system", content: PROJECT_GENERATION_SYSTEM_PROMPT },
    ...createPreferenceMessages(preferences),
    ...(researchContext
      ? [
          {
            role: "system",
            content: `Official docs research context:\n\n${researchContext}`,
          },
        ]
      : []),
    ...messages,
    {
      role: "user",
      content:
        "Generate the full project now. Return only the tagged project format exactly as requested.",
    },
  ];

  const data = await requestMistral({
    messages: generationMessages,
    temperature: typeof temperature === "number" ? Math.min(temperature, 0.4) : 0.2,
  });

  const content = extractAssistantContent(data);
  const parsed = await parseOrRetryTaggedProject(content, generationMessages);
  const normalizedProject = normalizeProjectBundle(parsed);
  validateCompletedProject(normalizedProject);
  return applyGeneratedProjectFixups(normalizedProject);
}

async function parseOrRetryTaggedProject(content, originalMessages) {
  try {
    const parsed = parseTaggedProjectFormat(content);
    validateCompletedProject(normalizeProjectBundle(parsed));
    return parsed;
  } catch (initialError) {
    const retryData = await requestMistral({
      messages: [
        { role: "system", content: PROJECT_GENERATION_SYSTEM_PROMPT },
        {
          role: "system",
          content:
            "Your previous response either did not follow the tagged format exactly or contained unfinished implementation. Regenerate the full project using the exact required tags and terminators only, and return fully finished code with no TODOs, placeholders, simplified-example comments, or instructions telling the user to implement logic manually.",
        },
        ...originalMessages.filter((message) => message.role !== "system"),
      ],
      temperature: 0.1,
    });

    const retriedContent = extractAssistantContent(retryData);

    try {
      const parsed = parseTaggedProjectFormat(retriedContent);
      validateCompletedProject(normalizeProjectBundle(parsed));
      return parsed;
    } catch (retryError) {
      throw new Error(
        `The project generator returned an invalid or unfinished project after retry. Initial error: ${
          initialError instanceof Error ? initialError.message : String(initialError)
        }. Retry error: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`
      );
    }
  }
}

function parseTaggedProjectFormat(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").trim();

  const projectName = readTaggedScalar(normalized, "PROJECT_NAME");
  const projectSlug = readTaggedScalar(normalized, "PROJECT_SLUG");
  const targetType = readTaggedScalar(normalized, "TARGET_TYPE");
  const minecraftVersion = readTaggedScalar(normalized, "MINECRAFT_VERSION");
  const javaVersionRaw = readTaggedScalar(normalized, "JAVA_VERSION");
  const buildTool = readTaggedScalar(normalized, "BUILD_TOOL");
  const summary = readOptionalTaggedBlock(normalized, "SUMMARY", "END_SUMMARY");
  const buildUnsupportedReason = readOptionalTaggedBlock(
    normalized,
    "BUILD_UNSUPPORTED_REASON",
    "END_BUILD_UNSUPPORTED_REASON"
  );

  const files = [];
  const filePattern = /^FILE:\s*(.+)\n([\s\S]*?)\nEND_FILE$/gm;
  let match;

  while ((match = filePattern.exec(normalized)) !== null) {
    files.push({
      path: match[1].trim(),
      content: match[2],
    });
  }

  if (files.length === 0) {
    throw new Error("No FILE blocks were found in the generator response.");
  }

  return {
    projectName,
    projectSlug,
    targetType,
    minecraftVersion,
    javaVersion: Number(javaVersionRaw) || 21,
    buildTool,
    summary,
    buildUnsupportedReason,
    files,
  };
}

function readTaggedScalar(text, tag) {
  const match = text.match(new RegExp(`^${escapeRegex(tag)}:\\s*(.+)$`, "m"));
  if (!match) {
    throw new Error(`Missing ${tag} field.`);
  }
  return match[1].trim();
}

function readTaggedBlock(text, startTag, endTag) {
  const match = text.match(
    new RegExp(`^${escapeRegex(startTag)}:\\s*\\n([\\s\\S]*?)\\n^${escapeRegex(endTag)}$`, "m")
  );
  if (!match) {
    throw new Error(`Missing ${startTag}/${endTag} block.`);
  }
  return match[1].trim();
}

function readOptionalTaggedBlock(text, startTag, endTag) {
  const match = text.match(
    new RegExp(`^${escapeRegex(startTag)}:\\s*\\n([\\s\\S]*?)\\n^${escapeRegex(endTag)}$`, "m")
  );
  return match ? match[1].trim() : "";
}

function normalizeProjectBundle(project) {
  const rawName =
    typeof project?.projectName === "string" && project.projectName.trim()
      ? project.projectName.trim()
      : "Minecraft Project";
  const projectSlug = sanitizeSlug(
    typeof project?.projectSlug === "string" && project.projectSlug.trim()
      ? project.projectSlug
      : rawName
  );
  const files = Array.isArray(project?.files)
    ? project.files
        .filter(
          (file) =>
            file &&
            typeof file.path === "string" &&
            file.path.trim() &&
            typeof file.content === "string"
        )
        .map((file) => ({
          path: sanitizeRelativePath(file.path),
          content: file.content.replace(/\r?\n/g, "\n"),
        }))
        .filter((file) => file.path)
    : [];

  if (files.length === 0) {
    throw new Error("The generated project did not include any files.");
  }

  return {
    projectName: rawName,
    projectSlug,
    targetType:
      typeof project?.targetType === "string" && project.targetType.trim()
        ? project.targetType.trim()
        : "generic-java",
    minecraftVersion:
      typeof project?.minecraftVersion === "string" && project.minecraftVersion.trim()
        ? project.minecraftVersion.trim()
        : "1.21.1",
    javaVersion:
      typeof project?.javaVersion === "number" && Number.isFinite(project.javaVersion)
        ? project.javaVersion
        : 21,
    buildTool: project?.buildTool === "gradle" ? "gradle" : "none",
    summary:
      typeof project?.summary === "string" && project.summary.trim()
        ? project.summary.trim()
        : "",
    buildUnsupportedReason:
      typeof project?.buildUnsupportedReason === "string"
        ? project.buildUnsupportedReason.trim()
        : "",
    files,
  };
}

function validateCompletedProject(project) {
  const incompleteMarkers = [
    "todo",
    "placeholder",
    "implementation omitted",
    "rest of the file",
    "fill in the rest",
    "you can implement",
    "you should implement",
    "finish wiring",
    "stub",
    "pseudo-code",
    "pseudocode",
    "for brevity",
    "left as an exercise",
    "continue this pattern",
    "remaining files would",
    "simplified example",
    "you'll need to implement",
    "you will need to implement",
    "implement your own logic",
    "finish this manually",
    "not fully implemented",
    "example only",
    "add your own",
  ];

  for (const file of project.files) {
    const normalizedContent = normalizeCompletenessText(file.content);
    const matched = incompleteMarkers.find((marker) => normalizedContent.includes(marker));
    if (matched) {
      throw new Error(
        `The generated project contains unfinished implementation in ${file.path}. Matched marker: "${matched}".`
      );
    }
  }
}

function applyGeneratedProjectFixups(project) {
  if (project.targetType === "fabric-mod") {
    applyFabricProjectFixups(project);
  }

  return project;
}

function applyFabricProjectFixups(project) {
  upsertProjectFile(
    project,
    "settings.gradle",
    (existing) => ensureFabricSettingsGradle(existing)
  );

  upsertProjectFile(
    project,
    "gradle.properties",
    (existing) => ensureFabricGradleProperties(existing, project)
  );

  upsertProjectFile(
    project,
    "build.gradle",
    (existing) => ensureFabricBuildGradle(existing, project)
  );
}

function upsertProjectFile(project, filePath, transform) {
  const normalizedPath = sanitizeRelativePath(filePath);
  const index = project.files.findIndex((file) => file.path === normalizedPath);

  if (index >= 0) {
    project.files[index].content = transform(project.files[index].content);
    return;
  }

  project.files.push({
    path: normalizedPath,
    content: transform(""),
  });
}

function ensureFabricSettingsGradle(existing) {
  const pluginManagementBlock = `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
`;

  const normalized = existing.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const rootProjectNameMatch = normalized.match(/^\s*rootProject\.name\s*=\s*.+$/m);
  const includeLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        (/^include(?:Flat)?\b/.test(line) || /^includeBuild\b/.test(line)) &&
        !line.startsWith("//")
    );

  const safeLines = [];
  if (rootProjectNameMatch) {
    safeLines.push(rootProjectNameMatch[0].trim());
  }
  safeLines.push(...includeLines);

  if (safeLines.length === 0) {
    safeLines.push("rootProject.name = 'forgefreeai-mod'");
  }

  return `${pluginManagementBlock}\n${safeLines.join("\n")}\n`;
}

function ensureFabricGradleProperties(existing, project) {
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const fabricDefaults = resolveFabricDefaults(project.minecraftVersion);
  const requiredDefaults = {
    "org.gradle.jvmargs": "-Xmx1G",
    "org.gradle.parallel": "true",
    "org.gradle.configuration-cache": "false",
    "loom_version": "1.14-SNAPSHOT",
    "fabric_version": fabricDefaults.fabricApiVersion,
  };

  for (const [key, value] of Object.entries(requiredDefaults)) {
    if (!lines.some((line) => line.trim().startsWith(`${key}=`))) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join("\n").trim() + "\n";
}

function ensureFabricBuildGradle(existing, project) {
  const fabricDefaults = resolveFabricDefaults(project.minecraftVersion);
  const metadata = extractFabricBuildMetadata(existing, project, fabricDefaults);

  return `plugins {
    id 'net.fabricmc.fabric-loom-remap' version "\${loom_version}"
    id 'maven-publish'
}

version = '${metadata.modVersion}'
group = '${metadata.mavenGroup}'

base {
    archivesName = '${metadata.archivesBaseName}'
}

repositories {
    maven { url = 'https://maven.fabricmc.net/' }
    mavenCentral()
}

dependencies {
    minecraft "com.mojang:minecraft:${metadata.minecraftVersion}"
    mappings "net.fabricmc:yarn:${metadata.yarnMappings}:v2"
    modImplementation "net.fabricmc:fabric-loader:${metadata.loaderVersion}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:${metadata.fabricApiVersion}"
}

processResources {
    inputs.property "version", project.version

    filesMatching("fabric.mod.json") {
        expand "version": project.version
    }
}

tasks.withType(JavaCompile).configureEach {
    it.options.release = ${metadata.javaVersion}
}

java {
    withSourcesJar()
    sourceCompatibility = JavaVersion.VERSION_${metadata.javaVersion}
    targetCompatibility = JavaVersion.VERSION_${metadata.javaVersion}
}

publishing {
    publications {
        create("mavenJava", MavenPublication) {
            artifactId = project.base.archivesName.get()
            from components.java
        }
    }
}
`;
}

function extractFabricBuildMetadata(existing, project, fabricDefaults) {
  const buildGradle = existing.replace(/\r\n/g, "\n");
  const fabricModJsonFile = project.files.find(
    (file) => file.path === "src/main/resources/fabric.mod.json"
  );
  let fabricModJson = null;

  if (fabricModJsonFile) {
    try {
      fabricModJson = JSON.parse(fabricModJsonFile.content);
    } catch (_error) {
      fabricModJson = null;
    }
  }

  return {
    modVersion:
      captureMatch(buildGradle, /^\s*version\s*=\s*['"]([^'"]+)['"]/m) ||
      normalizeFabricVersion(fabricModJson?.version) ||
      "1.0.0",
    mavenGroup:
      captureMatch(buildGradle, /^\s*group\s*=\s*['"]([^'"]+)['"]/m) ||
      guessJavaPackageGroup(project) ||
      "com.example",
    archivesBaseName:
      (fabricModJson && typeof fabricModJson.id === "string" && fabricModJson.id.trim()) ||
      project.projectSlug ||
      "forgefreeai-mod",
    minecraftVersion:
      project.minecraftVersion ||
      captureMatch(buildGradle, /minecraft\s+['"]com\.mojang:minecraft:([^'"]+)['"]/m) ||
      "1.21.1",
    yarnMappings:
      captureMatch(buildGradle, /mappings\s+['"]net\.fabricmc:yarn:([^'"]+):v2['"]/m) ||
      fabricDefaults.yarnMappings,
    loaderVersion:
      captureMatch(buildGradle, /fabric-loader:([^'"]+)['"]/m) ||
      normalizeFabricLoaderVersion(fabricModJson?.depends?.fabricloader) ||
      fabricDefaults.loaderVersion,
    fabricApiVersion: fabricDefaults.fabricApiVersion,
    javaVersion:
      typeof project.javaVersion === "number" && Number.isFinite(project.javaVersion)
        ? project.javaVersion
        : 21,
  };
}

function resolveFabricDefaults(minecraftVersion) {
  const version = String(minecraftVersion || "").trim();

  if (version === "1.21.1") {
    return {
      fabricApiVersion: "0.116.9+1.21.1",
      yarnMappings: "1.21.1+build.1",
      loaderVersion: "0.15.11",
    };
  }

  if (version === "1.21.11") {
    return {
      fabricApiVersion: "0.139.4+1.21.11",
      yarnMappings: "1.21.11+build.1",
      loaderVersion: "0.18.2",
    };
  }

  if (version.startsWith("1.21")) {
    return {
      fabricApiVersion: "0.116.9+1.21.1",
      yarnMappings: "1.21.1+build.1",
      loaderVersion: "0.15.11",
    };
  }

  return {
    fabricApiVersion: "0.116.9+1.21.1",
    yarnMappings: "1.21.1+build.1",
    loaderVersion: "0.15.11",
  };
}

function captureMatch(text, pattern) {
  const match = String(text || "").match(pattern);
  return match?.[1]?.trim() || "";
}

function normalizeFabricVersion(value) {
  const version = String(value || "").trim();
  if (!version || version.includes("${")) {
    return "";
  }
  return version;
}

function normalizeFabricLoaderVersion(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] || "";
}

function guessJavaPackageGroup(project) {
  const javaFile = project.files.find((file) => file.path.endsWith(".java"));
  if (!javaFile) {
    return "";
  }

  const packageMatch = javaFile.content.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m);
  if (!packageMatch) {
    return "";
  }

  const packageName = packageMatch[1];
  const lastDot = packageName.lastIndexOf(".");
  return lastDot > 0 ? packageName.slice(0, lastDot) : packageName;
}

async function buildProjectSession(messages, temperature, preferences) {
  const project = await generateProjectBundle(messages, temperature, preferences);
  if (project.buildTool !== "gradle") {
    throw new Error(
      project.buildUnsupportedReason ||
        "This chat resolved to a project type that does not support JAR builds."
    );
  }

  const workspace = await materializeProject(project);
  const gradleBat = await ensureGradleDistribution();
  const attemptLogs = [];
  const repairSummaries = [];
  let attempt = 1;
  let lastFailureSignature = "";
  let stalledFailureCount = 0;

  while (MAX_BUILD_REPAIR_ATTEMPTS <= 0 || attempt <= MAX_BUILD_REPAIR_ATTEMPTS) {
    await writeProjectFiles(project, workspace.projectDir);

    try {
      const buildResult = await runGradleBuild(gradleBat, workspace.projectDir);
      const jarPath = await findBuiltJar(workspace.projectDir);
      if (!jarPath) {
        throw new Error("Gradle finished but no usable JAR was found in build/libs.");
      }

      const sourceZipPath = path.join(workspace.outputDir, `${project.projectSlug}-source.zip`);
      await createZipFromDirectory(workspace.projectDir, sourceZipPath);

      const manifest = await saveBuildSessionManifest({
        project,
        workspace,
        jarPath,
        sourceZipPath,
        attemptLogs,
        repairSummaries,
        buildResult,
      });

      return manifest;
    } catch (error) {
      const buildLog = extractBuildErrorLog(error);
      const failureSignature = createFailureSignature(buildLog);
      stalledFailureCount =
        failureSignature === lastFailureSignature ? stalledFailureCount + 1 : 1;
      lastFailureSignature = failureSignature;

      attemptLogs.push({
        attempt,
        log: buildLog,
      });

      if (MAX_BUILD_REPAIR_ATTEMPTS > 0 && attempt >= MAX_BUILD_REPAIR_ATTEMPTS) {
        throw new Error(
          `Gradle build failed after ${attempt} attempts.\n\n${truncateOutput(buildLog, 3500)}`
        );
      }

      if (stalledFailureCount >= MAX_STALLED_BUILD_ATTEMPTS) {
        throw new Error(
          `Gradle build stalled after ${attempt} attempts with the same error repeating ${stalledFailureCount} times.\n\n${truncateOutput(buildLog, 3500)}`
        );
      }

      const repair = await repairProjectFromBuildError(project, buildLog, attempt);
      if (repair.summary) {
        repairSummaries.push(`Attempt ${attempt}: ${repair.summary}`);
      }

      const changed = applyProjectRepair(project, repair);
      applyGeneratedProjectFixups(project);

      if (!changed) {
        throw new Error(
          `The repair step produced no file changes on attempt ${attempt}.\n\n${truncateOutput(buildLog, 3500)}`
        );
      }

      attempt += 1;
    }
  }

  throw new Error("The build loop exited unexpectedly.");
}

async function saveBuildSessionManifest({
  project,
  workspace,
  jarPath,
  sourceZipPath,
  attemptLogs,
  repairSummaries,
}) {
  const sessionId = path.basename(workspace.outputDir);
  const manifestPath = path.join(buildSessionsDir, `${sessionId}.json`);
  const artifacts = [
    {
      kind: "jar",
      path: jarPath,
      name: path.basename(jarPath),
      contentType: "application/java-archive",
      downloadUrl: `/api/artifacts/${sessionId}/jar`,
    },
    {
      kind: "source",
      path: sourceZipPath,
      name: path.basename(sourceZipPath),
      contentType: "application/zip",
      downloadUrl: `/api/artifacts/${sessionId}/source`,
    },
  ];
  const manifest = {
    sessionId,
    projectName: project.projectName,
    projectSlug: project.projectSlug,
    targetType: project.targetType,
    summary: createBuildSummary(project, attemptLogs, repairSummaries),
    attempts: attemptLogs.length + 1,
    repairSummaries,
    attemptLogs: attemptLogs.map((entry) => ({
      attempt: entry.attempt,
      log: truncateOutput(entry.log, 1600),
    })),
    artifacts,
  };

  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function createBuildSummary(project, attemptLogs, repairSummaries) {
  const lines = [
    `Built \`${project.projectName}\` successfully.`,
    "",
    `Project type: ${project.targetType}`,
    `Build attempts: ${attemptLogs.length + 1}`,
  ];

  if (repairSummaries.length > 0) {
    lines.push("", "Auto-fixes applied:");
    for (const summary of repairSummaries) {
      lines.push(`- ${summary}`);
    }
  }

  lines.push(
    "",
    "The fixed JAR and fixed source ZIP are ready below."
  );

  return lines.join("\n");
}

function extractBuildErrorLog(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Gradle build failed\.\n\n/, "").trim();
}

function createFailureSignature(buildLog) {
  return String(buildLog)
    .replace(/\r\n/g, "\n")
    .replace(/\bC:\\[^\n:]+/g, "PATH")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 1200);
}

async function repairProjectFromBuildError(project, buildLog, attempt) {
  const researchContext = await gatherResearchContext({
    project,
    buildLog,
    messages: [],
  });
  const response = await requestMistral({
    messages: [
      { role: "system", content: BUILD_REPAIR_SYSTEM_PROMPT },
      ...(researchContext
        ? [
            {
              role: "system",
              content: `Official docs research context:\n\n${researchContext}`,
            },
          ]
        : []),
      {
        role: "user",
        content: [
          `Attempt: ${attempt}`,
          `Project name: ${project.projectName}`,
          `Project type: ${project.targetType}`,
          `Minecraft version: ${project.minecraftVersion}`,
          `Java version: ${project.javaVersion}`,
          "",
          "Current project files:",
          serializeProjectFiles(project.files),
          "",
          "Gradle build log:",
          truncateOutput(buildLog, 12000),
          "",
          "Fix the exact compile or Gradle error for the current Minecraft version and APIs. Replace removed or outdated APIs with valid ones for this version.",
          "",
          "Return only the changed files using the tagged repair format.",
        ].join("\n"),
      },
    ],
    temperature: 0.1,
  });

  return parseRepairResponse(extractAssistantContent(response));
}

function serializeProjectFiles(files) {
  return files
    .map(
      (file) =>
        `FILE: ${file.path}\n${file.content.replace(/\r\n/g, "\n")}\nEND_FILE`
    )
    .join("\n");
}

function parseRepairResponse(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").trim();
  const summary = readOptionalTaggedBlock(normalized, "SUMMARY", "END_SUMMARY");
  const filePattern = /^FILE:\s*(.+)\n([\s\S]*?)\nEND_FILE$/gm;
  const deletePattern = /^DELETE_FILE:\s*(.+)$/gm;
  const files = [];
  const deletes = [];
  let match;

  while ((match = filePattern.exec(normalized)) !== null) {
    files.push({
      path: sanitizeRelativePath(match[1].trim()),
      content: match[2],
    });
  }

  while ((match = deletePattern.exec(normalized)) !== null) {
    const deletePath = sanitizeRelativePath(match[1].trim());
    if (deletePath) {
      deletes.push(deletePath);
    }
  }

  if (files.length === 0 && deletes.length === 0) {
    throw new Error("The repair response did not contain any file changes.");
  }

  for (const file of files) {
    const normalizedContent = normalizeCompletenessText(file.content);
    const incompleteMarkers = [
      "todo",
      "placeholder",
      "implementation omitted",
      "you'll need to implement",
      "you will need to implement",
      "implement your own logic",
      "simplified example",
      "finish this manually",
      "left as an exercise",
      "pseudocode",
      "pseudo-code",
    ];
    const matched = incompleteMarkers.find((marker) => normalizedContent.includes(marker));
    if (matched) {
      throw new Error(
        `The repair response still contains unfinished implementation in ${file.path}. Matched marker: "${matched}".`
      );
    }
  }

  return {
    summary,
    files: files.filter((file) => file.path),
    deletes,
  };
}

async function gatherResearchContext({ messages, project, buildLog }) {
  const targetType = project?.targetType || inferTargetType(messages);
  const sources = RESEARCH_SOURCE_MAP[targetType] || [];
  if (sources.length === 0) {
    return "";
  }

  const selectedSources = sources.slice(0, MAX_RESEARCH_SOURCES);
  const notes = [];

  for (const source of selectedSources) {
    const note = await fetchResearchSource(source, buildLog);
    if (note) {
      notes.push(note);
    }
  }

  return notes.join("\n\n");
}

function inferTargetType(messages, preferences) {
  const preferenceTargetType = mapLoaderToTargetType(preferences?.loader);
  if (preferenceTargetType) {
    return preferenceTargetType;
  }

  const joined = normalizeMessages(messages)
    .map((message) => message.content.toLowerCase())
    .join("\n");

  if (/(fabric|loom|fabric mod)/i.test(joined)) return "fabric-mod";
  if (/(neoforge|neo forge)/i.test(joined)) return "neoforge-mod";
  if (/(forge mod|minecraft forge)/i.test(joined)) return "forge-mod";
  if (/(paper plugin|papermc|paper api)/i.test(joined)) return "paper-plugin";
  if (/(spigot plugin|spigot api)/i.test(joined)) return "spigot-plugin";
  if (/(bukkit plugin|bukkit api)/i.test(joined)) return "bukkit-plugin";
  if (/(velocity plugin|velocity api)/i.test(joined)) return "velocity-plugin";
  return "fabric-mod";
}

function mapLoaderToTargetType(loader) {
  const mapping = {
    fabric: "fabric-mod",
    forge: "forge-mod",
    neoforge: "neoforge-mod",
    paper: "paper-plugin",
    spigot: "spigot-plugin",
    bukkit: "bukkit-plugin",
    velocity: "velocity-plugin",
    datapack: "datapack",
    "resource-pack": "resource-pack",
  };

  return mapping[loader] || "";
}

async function fetchResearchSource(source, buildLog) {
  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": "ForgefreeAI/1.0",
      },
    });

    if (!response.ok) {
      return "";
    }

    const html = await response.text();
    const text = extractMeaningfulDocText(html, buildLog);
    if (!text) {
      return "";
    }

    return `Source: ${source.label}\nURL: ${source.url}\nNotes: ${text}`;
  } catch (_error) {
    return "";
  }
}

function extractMeaningfulDocText(html, buildLog) {
  const text = stripHtml(html);
  if (!text) {
    return "";
  }

  const trimmed = text.slice(0, 20000);
  const buildTerms = extractBuildTerms(buildLog);

  if (buildTerms.length > 0) {
    for (const term of buildTerms) {
      const index = trimmed.toLowerCase().indexOf(term.toLowerCase());
      if (index !== -1) {
        const start = Math.max(0, index - 600);
        const end = Math.min(trimmed.length, index + 1600);
        return trimmed.slice(start, end).trim().slice(0, MAX_RESEARCH_CHARS_PER_SOURCE);
      }
    }
  }

  return trimmed.slice(0, MAX_RESEARCH_CHARS_PER_SOURCE).trim();
}

function extractBuildTerms(buildLog) {
  if (!buildLog) {
    return [];
  }

  const candidates = String(buildLog)
    .match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g);

  if (!candidates) {
    return [];
  }

  return [...new Set(candidates)]
    .filter((term) => !/^(java|gradle|error|failed|task|build)$/i.test(term))
    .slice(0, 12);
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function applyProjectRepair(project, repair) {
  let changed = false;

  for (const deletePath of repair.deletes) {
    const beforeLength = project.files.length;
    project.files = project.files.filter((file) => file.path !== deletePath);
    if (project.files.length !== beforeLength) {
      changed = true;
    }
  }

  for (const file of repair.files) {
    const existingIndex = project.files.findIndex((entry) => entry.path === file.path);
    const normalizedContent = file.content.replace(/\r?\n/g, "\n");
    if (existingIndex >= 0) {
      if (project.files[existingIndex].content !== normalizedContent) {
        project.files[existingIndex].content = normalizedContent;
        changed = true;
      }
    } else {
      project.files.push({
        path: file.path,
        content: normalizedContent,
      });
      changed = true;
    }
  }

  return changed;
}

async function writeProjectFiles(project, projectDir) {
  for (const file of project.files) {
    const targetPath = path.join(projectDir, file.path);
    if (!targetPath.startsWith(projectDir)) {
      throw new Error(`Unsafe file path was generated: ${file.path}`);
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, file.content, "utf8");
  }

  await ensureGeneratedTextures(project, projectDir);
}

async function ensureGeneratedTextures(project, projectDir) {
  const textureTargets = collectMissingTextureTargets(project);

  for (const target of textureTargets) {
    const fullPath = path.join(projectDir, target.path);
    if (!fullPath.startsWith(projectDir) || fs.existsSync(fullPath)) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, createPlaceholderTexturePng(target));
  }
}

function collectMissingTextureTargets(project) {
  const existingPaths = new Set(project.files.map((file) => file.path));
  const targets = new Map();

  for (const file of project.files) {
    if (!/^src\/main\/resources\/assets\/[^/]+\/models\/.+\.json$/i.test(file.path)) {
      continue;
    }

    const namespaceMatch = file.path.match(/^src\/main\/resources\/assets\/([^/]+)\//i);
    const defaultNamespace = namespaceMatch?.[1];
    if (!defaultNamespace) {
      continue;
    }

    for (const ref of extractTextureReferences(file.content, defaultNamespace)) {
      const texturePath = `src/main/resources/assets/${ref.namespace}/textures/${ref.relative}.png`;
      if (!existingPaths.has(texturePath) && !targets.has(texturePath)) {
        targets.set(texturePath, {
          path: texturePath,
          namespace: ref.namespace,
          relative: ref.relative,
        });
      }
    }
  }

  return [...targets.values()];
}

function extractTextureReferences(content, defaultNamespace) {
  const refs = [];

  try {
    const parsed = JSON.parse(content);
    walkJson(parsed, (value, key) => {
      if (typeof value !== "string" || key === "parent") {
        return;
      }

      const ref = normalizeTextureReference(value, defaultNamespace);
      if (ref) {
        refs.push(ref);
      }
    });
  } catch (_error) {
    const regex =
      /"(?:layer\d+|all|side|top|bottom|end|particle|north|south|east|west|up|down)"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const ref = normalizeTextureReference(match[1], defaultNamespace);
      if (ref) {
        refs.push(ref);
      }
    }
  }

  return refs;
}

function normalizeTextureReference(value, defaultNamespace) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#")) {
    return null;
  }

  const [namespace, relativePart] = raw.includes(":")
    ? raw.split(":", 2)
    : [defaultNamespace, raw];
  let relative = String(relativePart || "")
    .replace(/\\/g, "/")
    .replace(/\.(png|jpg|jpeg)$/i, "")
    .replace(/^\/+/, "");

  if (!/^(block|item|entity|gui|particle)\//.test(relative) || relative.includes("..")) {
    return null;
  }

  return {
    namespace: namespace || defaultNamespace,
    relative,
  };
}

function walkJson(value, visitor, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, visitor, key);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      visitor(childValue, childKey);
      walkJson(childValue, visitor, childKey);
    }
  }
}

function createPlaceholderTexturePng(target) {
  const width = 16;
  const height = 16;
  const hash = simpleHash(`${target.namespace}:${target.relative}`);
  const primary = colorFromHash(hash);
  const secondary = colorFromHash(hash ^ 0x5f356495);
  const accent = colorFromHash(hash ^ 0x00abc123);
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const isChecker = (x + y + (hash & 1)) % 2 === 0;
      const isStripe = ((x * 5 + y * 3 + hash) % 7) < 2;
      const color = isBorder ? accent : isStripe ? secondary : isChecker ? primary : secondary;

      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = 255;
    }
  }

  return encodePng(width, height, pixels);
}

function simpleHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorFromHash(hash) {
  const hue = hash % 360;
  const saturation = 55 + (hash % 25);
  const lightness = 35 + (hash % 18);
  return hslToRgb(hue / 360, saturation / 100, lightness / 100);
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }

  const hueToRgb = (p, q, t) => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

function encodePng(width, height, rgbaPixels) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    rgbaPixels.copy(row, 1, rowStart, rowStart + width * 4);
    rows.push(row);
  }

  const compressed = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk("IHDR", createIhdrData(width, height)),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createIhdrData(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function loadBuildSessionManifest(sessionId) {
  const manifestPath = path.join(buildSessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const content = await fs.promises.readFile(manifestPath, "utf8");
  return JSON.parse(content);
}

async function materializeProject(project) {
  const workspaceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputDir = path.join(generatedDir, workspaceId);
  const projectDir = path.join(outputDir, project.projectSlug);

  await fs.promises.mkdir(projectDir, { recursive: true });
  await writeProjectFiles(project, projectDir);

  return { outputDir, projectDir };
}

async function createZipFromDirectory(sourceDir, zipPath) {
  const entries = await collectZipEntries(sourceDir);
  const parts = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(entry.dosTime, 10);
    localHeader.writeUInt16LE(entry.dosDate, 12);
    localHeader.writeUInt32LE(entry.crc32, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(entry.dosTime, 12);
    centralHeader.writeUInt16LE(entry.dosDate, 14);
    centralHeader.writeUInt32LE(entry.crc32, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.isDirectory ? 0x10 : 0x20, 38);
    centralHeader.writeUInt32LE(offset, 42);

    parts.push(localHeader, nameBuffer, entry.data);
    centralDirectory.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + entry.data.length;
  }

  const centralDirectoryBuffer = Buffer.concat(centralDirectory);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  await fs.promises.writeFile(zipPath, Buffer.concat([...parts, centralDirectoryBuffer, endRecord]));
}

async function collectZipEntries(sourceDir, currentDir = sourceDir) {
  const dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const zipEntries = [];

  for (const dirEntry of dirEntries) {
    const fullPath = path.join(currentDir, dirEntry.name);
    const relativePath = path.relative(sourceDir, fullPath).replace(/\\/g, "/");

    if (dirEntry.isDirectory()) {
      const stats = await fs.promises.stat(fullPath);
      zipEntries.push(createZipEntry(`${relativePath}/`, Buffer.alloc(0), stats.mtime, true));
      zipEntries.push(...(await collectZipEntries(sourceDir, fullPath)));
      continue;
    }

    if (dirEntry.isFile()) {
      const [stats, data] = await Promise.all([
        fs.promises.stat(fullPath),
        fs.promises.readFile(fullPath),
      ]);
      zipEntries.push(createZipEntry(relativePath, data, stats.mtime, false));
    }
  }

  return zipEntries.sort((a, b) => a.name.localeCompare(b.name));
}

function createZipEntry(name, data, modifiedAt, isDirectory) {
  const { dosDate, dosTime } = toZipDosDateTime(modifiedAt);
  return {
    name,
    data,
    dosDate,
    dosTime,
    isDirectory,
    crc32: crc32(data),
  };
}

function toZipDosDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = Math.max(1980, date.getFullYear());
  const month = Math.max(1, date.getMonth() + 1);
  const day = Math.max(1, date.getDate());
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosTime: (hours << 11) | (minutes << 5) | seconds,
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
  };
}

async function ensureGradleDistribution() {
  const gradleDir = path.join(gradleCacheDir, GRADLE_DIR_NAME);
  const gradleExecutable = path.join(gradleDir, "bin", IS_WINDOWS ? "gradle.bat" : "gradle");

  if (fs.existsSync(gradleExecutable)) {
    if (!IS_WINDOWS) {
      await fs.promises.chmod(gradleExecutable, 0o755).catch(() => {});
    }
    return gradleExecutable;
  }

  const zipPath = path.join(gradleCacheDir, GRADLE_ZIP_NAME);
  if (!fs.existsSync(zipPath)) {
    const response = await fetch(GRADLE_DOWNLOAD_URL);
    if (!response.ok) {
      throw new Error(`Unable to download Gradle ${GRADLE_VERSION}.`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(zipPath, buffer);
  }

  await extractZipArchive(zipPath, gradleCacheDir);

  if (!fs.existsSync(gradleExecutable)) {
    throw new Error("Gradle downloaded, but the executable could not be found.");
  }

  if (!IS_WINDOWS) {
    await fs.promises.chmod(gradleExecutable, 0o755).catch(() => {});
  }

  return gradleExecutable;
}

async function runGradleBuild(gradleExecutable, cwd) {
  const javaBinDir = await resolveJavaBinDir();
  if (!javaBinDir) {
    throw new Error("Java was not found on PATH, so the JAR build cannot start.");
  }

  const processPath = [javaBinDir, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
  const javaToolOptions = joinJavaToolOptions(
    process.env.JAVA_TOOL_OPTIONS || "",
    `-Djava.io.tmpdir=${quoteJavaPropertyPath(gradleTempDir)}`
  );
  const gradleOpts = joinJavaToolOptions(
    process.env.GRADLE_OPTS || "",
    `-Djava.io.tmpdir=${quoteJavaPropertyPath(gradleTempDir)}`
  );

  try {
    const execOptions = {
      cwd,
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GRADLE_USER_HOME: gradleUserHome,
        TEMP: gradleTempDir,
        TMP: gradleTempDir,
        PATH: processPath,
        JAVA_TOOL_OPTIONS: javaToolOptions,
        GRADLE_OPTS: gradleOpts,
      },
    };

    if (IS_WINDOWS) {
      const gradleCommand = `& ${toPowerShellString(gradleExecutable)} build --no-daemon --console=plain`;
      return await execFileAsync(POWERSHELL, ["-NoProfile", "-Command", gradleCommand], execOptions);
    }

    return await execFileAsync(
      gradleExecutable,
      ["build", "--no-daemon", "--console=plain"],
      execOptions
    );
  } catch (error) {
    const stdout = error?.stdout || "";
    const stderr = error?.stderr || "";
    throw new Error(
      `Gradle build failed.\n\n${truncateOutput(stderr || stdout || String(error), 2500)}`
    );
  }
}

async function findBuiltJar(projectDir) {
  const libsDir = path.join(projectDir, "build", "libs");
  if (!fs.existsSync(libsDir)) {
    return null;
  }

  const files = await fs.promises.readdir(libsDir);
  const candidates = [];

  for (const file of files) {
    if (!file.toLowerCase().endsWith(".jar")) {
      continue;
    }

    const fullPath = path.join(libsDir, file);
    const stats = await fs.promises.stat(fullPath);
    candidates.push({
      fullPath,
      file,
      score: scoreJarFilename(file),
      mtimeMs: stats.mtimeMs,
    });
  }

  candidates.sort((a, b) => a.score - b.score || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fullPath || null;
}

function scoreJarFilename(file) {
  const lower = file.toLowerCase();
  let score = 0;
  if (lower.includes("-sources")) score += 100;
  if (lower.includes("-javadoc")) score += 100;
  if (lower.includes("-dev")) score += 70;
  if (lower.includes("-plain")) score += 40;
  if (lower.includes("shadow")) score -= 10;
  if (lower.includes("remap")) score -= 15;
  return score;
}

async function hasJava() {
  return Boolean(await resolveJavaBinDir());
}

async function resolveJavaBinDir() {
  const pathEntries = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const javaBinary = path.join(entry, IS_WINDOWS ? "java.exe" : "java");
    if (fs.existsSync(javaBinary)) {
      return entry;
    }
  }

  try {
    const lookupCommand = IS_WINDOWS ? "where.exe" : "which";
    const result = await execFileAsync(lookupCommand, ["java"], { timeout: 10000 });
    const firstPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return firstPath ? path.dirname(firstPath) : "";
  } catch (_error) {
    return "";
  }
}

async function extractZipArchive(zipPath, destinationDir) {
  if (IS_WINDOWS) {
    await runPowerShellCommand(
      `Expand-Archive -LiteralPath ${toPowerShellString(zipPath)} -DestinationPath ${toPowerShellString(destinationDir)} -Force`
    );
    return;
  }

  try {
    await extractZipArchiveInProcess(zipPath, destinationDir);
  } catch (error) {
    throw new Error(error?.stderr || error?.stdout || "Unable to extract the Gradle archive.");
  }
}

async function extractZipArchiveInProcess(zipPath, destinationDir) {
  const buffer = await fs.promises.readFile(zipPath);
  const centralDirectory = findZipCentralDirectory(buffer);

  for (const entry of centralDirectory.entries) {
    const targetPath = path.join(destinationDir, ...entry.name.split("/"));
    const normalizedTargetPath = path.resolve(targetPath);
    const normalizedDestination = path.resolve(destinationDir);

    if (!normalizedTargetPath.startsWith(normalizedDestination)) {
      throw new Error(`Refusing to extract unsafe ZIP entry: ${entry.name}`);
    }

    if (entry.isDirectory) {
      await fs.promises.mkdir(normalizedTargetPath, { recursive: true });
      continue;
    }

    await fs.promises.mkdir(path.dirname(normalizedTargetPath), { recursive: true });
    const fileData = readZipEntryData(buffer, entry);
    await fs.promises.writeFile(normalizedTargetPath, fileData);
  }
}

function findZipCentralDirectory(buffer) {
  const minEocdSize = 22;
  const maxCommentLength = 0xffff;
  const startIndex = Math.max(0, buffer.length - (minEocdSize + maxCommentLength));

  for (let offset = buffer.length - minEocdSize; offset >= startIndex; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }

    const totalEntries = buffer.readUInt16LE(offset + 10);
    const centralDirectorySize = buffer.readUInt32LE(offset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(offset + 16);
    const entries = [];
    let cursor = centralDirectoryOffset;

    for (let index = 0; index < totalEntries; index += 1) {
      if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error("Invalid ZIP central directory header.");
      }

      const compressionMethod = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const fileNameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const externalFileAttributes = buffer.readUInt32LE(cursor + 38);
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      const nameStart = cursor + 46;
      const nameEnd = nameStart + fileNameLength;
      const entryName = buffer.toString("utf8", nameStart, nameEnd);

      entries.push({
        name: entryName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory: entryName.endsWith("/"),
        unixMode: externalFileAttributes >>> 16,
      });

      cursor = nameEnd + extraLength + commentLength;
    }

    return {
      size: centralDirectorySize,
      offset: centralDirectoryOffset,
      entries,
    };
  }

  throw new Error("Unable to locate the ZIP central directory.");
}

function readZipEntryData(buffer, entry) {
  const headerOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(headerOffset) !== 0x04034b50) {
    throw new Error(`Invalid local ZIP header for ${entry.name}.`);
  }

  const fileNameLength = buffer.readUInt16LE(headerOffset + 26);
  const extraLength = buffer.readUInt16LE(headerOffset + 28);
  const dataStart = headerOffset + 30 + fileNameLength + extraLength;
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressedData);
  }

  if (entry.compressionMethod === 8) {
    const inflated = zlib.inflateRawSync(compressedData);
    if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
      throw new Error(`ZIP entry size mismatch for ${entry.name}.`);
    }
    return inflated;
  }

  throw new Error(
    `Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}.`
  );
}

function selectWritableRuntimeRoot() {
  const candidates = [
    process.env.FORGEFREEAI_RUNTIME_ROOT,
    process.env.RENDER_DISK_MOUNT_PATH
      ? path.join(process.env.RENDER_DISK_MOUNT_PATH, "ForgefreeAI")
      : "",
    process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "ForgefreeAI")
      : "",
  ];

  if (IS_SERVERLESS) {
    candidates.push(path.join(os.tmpdir(), "ForgefreeAI"));
  }

  if (process.platform === "win32") {
    candidates.push(path.join(process.env.PUBLIC || path.join("C:", "Users", "Public"), "ForgefreeAI"));
    candidates.push(path.join(process.env.SystemDrive || "C:", "ForgefreeAI"));
  }

  candidates.push(workspaceRuntimeRoot);

  for (const candidate of candidates) {
    if (canPrepareDirectory(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to find a writable runtime directory for ForgefreeAI.");
}

function canPrepareDirectory(targetDir) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const probePath = path.join(targetDir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function quoteJavaPropertyPath(value) {
  const normalized = path.resolve(value);
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

function joinJavaToolOptions(existing, appended) {
  return [String(existing || "").trim(), appended].filter(Boolean).join(" ").trim();
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    return sendNotFound(res);
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch (_error) {
    try {
      const fallback = await fs.promises.readFile(path.join(publicDir, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(fallback);
    } catch (_fallbackError) {
      sendNotFound(res);
    }
  }
}

function createJsonResponse(status, payload) {
  return {
    type: "json",
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function createFileResponse(filePath, downloadName, contentType) {
  return {
    type: "file",
    status: 200,
    filePath,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Cache-Control": "no-store",
    },
  };
}

async function sendApiResponse(res, apiResponse) {
  if (apiResponse.type === "json") {
    res.writeHead(apiResponse.status, apiResponse.headers);
    res.end(apiResponse.body);
    return;
  }

  if (apiResponse.type === "file") {
    return sendFileDownload(res, apiResponse);
  }

  throw new Error("Unsupported API response type.");
}

async function sendFileDownload(res, apiResponse) {
  const { filePath, headers, status } = apiResponse;
  const stream = fs.createReadStream(filePath);
  res.writeHead(status, headers);

  stream.on("error", () => {
    if (!res.headersSent) {
      sendApiResponse(
        res,
        createJsonResponse(500, { error: "Unable to read the generated download file." })
      );
    } else {
      res.destroy();
    }
  });

  stream.pipe(res);
}

function sendNotFound(res) {
  sendApiResponse(res, createJsonResponse(404, { error: "Not found." }));
}

function sanitizeSlug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "minecraft-project"
  );
}

function sanitizeRelativePath(value) {
  const normalized = String(value).replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return "";
  }
  return normalized;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateOutput(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n...[truncated]`;
}

function toPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShellCommand(command) {
  if (!IS_WINDOWS) {
    throw new Error("PowerShell commands are only supported on Windows.");
  }

  try {
    await execFileAsync(POWERSHELL, ["-NoProfile", "-Command", command], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(error?.stderr || error?.stdout || String(error));
  }
}

async function createNetlifyResponse(apiResponse) {
  if (!apiResponse) {
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ error: "Not found." }),
    };
  }

  if (apiResponse.type === "json") {
    return {
      statusCode: apiResponse.status,
      headers: apiResponse.headers,
      body: apiResponse.body,
    };
  }

  if (apiResponse.type === "file") {
    const buffer = await fs.promises.readFile(apiResponse.filePath);
    return {
      statusCode: apiResponse.status,
      headers: apiResponse.headers,
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  }

  throw new Error("Unsupported API response type.");
}

async function createWebResponse(apiResponse) {
  if (!apiResponse) {
    return new Response(JSON.stringify({ error: "Not found." }), {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (apiResponse.type === "json") {
    return new Response(apiResponse.body, {
      status: apiResponse.status,
      headers: apiResponse.headers,
    });
  }

  if (apiResponse.type === "file") {
    const buffer = await fs.promises.readFile(apiResponse.filePath);
    return new Response(buffer, {
      status: apiResponse.status,
      headers: apiResponse.headers,
    });
  }

  throw new Error("Unsupported API response type.");
}

module.exports = {
  HOSTING_TARGET,
  IS_SERVERLESS,
  createServer,
  createNetlifyResponse,
  createWebResponse,
  processApiRequest,
};
