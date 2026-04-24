import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import chokidar from "chokidar";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const standaloneRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(standaloneRoot, "..");
const dataDir = path.resolve(standaloneRoot, "data");
const configPath = path.resolve(dataDir, "service.config.json");
const frontendDist = path.resolve(standaloneRoot, "frontend", "dist");
const launchPyPath = path.resolve(repoRoot, "pythonFiles", "launch.py");
const editorPort = Number(process.env.STANDALONE_EDITOR_PORT ?? 19322);
const webPort = Number(process.env.STANDALONE_WEB_PORT ?? 19321);
const debounceMsDefault = 250;
const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const clients = new Set();
let config = null;
let blenderProcess = null;
let watcher = null;
let reloadTimer = null;
let isReloading = false;
let pendingReload = false;
let pendingChangedPaths = new Set();
let activeInstance = null;
let blenderStopRequested = false;
let blenderCrashSuspected = false;
let restartAttempt = 0;
let lastReadBlendPath = null;
let lastCanonicalBlendPath = null;
let lastCrashReportPath = null;

const defaultConfig = {
  blenderExecutable: "",
  blenderArgs: [],
  mode: "launch",
  attach: {
    host: "127.0.0.1",
    blenderPort: 0
  },
  addonEntries: [],
  watcher: {
    enabled: true,
    debounceMs: debounceMsDefault,
    includeGlobs: ["**/*.py", "**/*.toml", "**/*.json"],
    ignoredGlobs: ["**/.git/**", "**/__pycache__/**", "**/*.pyc"]
  },
  environment: {},
  preReloadCommand: "",
  autoRestartOnCrash: false,
  openLatestAutosaveOnCrash: true
};

function emit(type, payload = {}) {
  const message = JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    ...payload
  });
  for (const response of clients) {
    response.write(`data: ${message}\n\n`);
  }
}

function emitLog(stream, level, message, details = undefined) {
  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`;
  if (level === "error" || level === "warn") {
    // Mirror to stderr/stdout so CLI users can read logs without the UI.
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  emit("log", { stream, level, message, details });
}

function logLine(level, message, details = undefined) {
  emitLog("service", level, message, details);
}

function logBlender(level, message, details = undefined) {
  emitLog("blender", level, message, details);
}

function detectCrashFromLog(message) {
  const text = String(message || "");
  return text.includes("EXCEPTION_ACCESS_VIOLATION")
    || text.includes("Writing:")
    || text.toLowerCase().includes(".crash.txt");
}

function updateCrashContextFromLog(message) {
  const text = String(message || "");
  const readMatch = text.match(/Read blend:\s*"([^"]+)"/i);
  if (readMatch) {
    const readPath = readMatch[1];
    lastReadBlendPath = readPath;
    if (!isLikelyRecoveryBlendPath(readPath)) {
      lastCanonicalBlendPath = readPath;
    }
  }
  const crashMatch = text.match(/Writing:\s*([^\r\n]+\.crash\.txt)/i);
  if (crashMatch) {
    lastCrashReportPath = crashMatch[1].trim();
  }
}

function isLikelyRecoveryBlendPath(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  const baseName = path.basename(normalized);
  return baseName.includes("autosave")
    || baseName.includes("recover")
    || /\.blend\d+$/.test(baseName);
}

async function getLatestBlendCandidateInDir(directoryPath, preferredBaseName = "") {
  try {
    const entries = await fsp.readdir(directoryPath);
    const candidates = [];
    for (const name of entries) {
      if (!/\.blend(\d+)?$/i.test(name)) {
        continue;
      }
      const fullPath = path.join(directoryPath, name);
      const stats = await fsp.stat(fullPath).catch(() => null);
      if (!stats?.isFile()) {
        continue;
      }
      const baseScore = preferredBaseName !== "" && name.toLowerCase().includes(preferredBaseName.toLowerCase()) ? 1 : 0;
      candidates.push({
        fullPath,
        mtimeMs: stats.mtimeMs,
        baseScore
      });
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
      return b.mtimeMs - a.mtimeMs;
    });
    return candidates[0].fullPath;
  } catch {
    return null;
  }
}

async function findLatestRecoveryBlend() {
  const checks = [];

  if (lastCrashReportPath) {
    const siblingBlend = lastCrashReportPath.replace(/\.crash\.txt$/i, ".blend");
    checks.push(siblingBlend);
  }

  const preferredSourcePath = lastCanonicalBlendPath || lastReadBlendPath;
  const preferredBaseName = preferredSourcePath ? path.basename(preferredSourcePath, ".blend") : "";
  const tempDirs = [
    process.env.TEMP,
    process.env.TMP,
    path.join(process.env.LOCALAPPDATA || "", "Temp")
  ].filter(Boolean);

  for (const tempDir of tempDirs) {
    const latestInTemp = await getLatestBlendCandidateInDir(tempDir, preferredBaseName);
    if (latestInTemp) {
      checks.push(latestInTemp);
    }
  }

  if (preferredSourcePath) {
    const sourceDir = path.dirname(preferredSourcePath);
    const latestNearSource = await getLatestBlendCandidateInDir(sourceDir, preferredBaseName);
    if (latestNearSource) {
      checks.push(latestNearSource);
    }
  }

  const verified = [];
  for (const candidate of checks) {
    const stats = await fsp.stat(candidate).catch(() => null);
    if (stats?.isFile()) {
      verified.push({ path: candidate, mtimeMs: stats.mtimeMs });
    }
  }

  if (verified.length === 0) {
    return null;
  }

  verified.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return verified[0].path;
}

async function ensureConfig() {
  await fsp.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    config = mergeConfig(parsed);
  } catch {
    config = structuredClone(defaultConfig);
    await persistConfig();
  }
}

function mergeConfig(partial) {
  return {
    ...defaultConfig,
    ...partial,
    attach: { ...defaultConfig.attach, ...(partial.attach ?? {}) },
    watcher: { ...defaultConfig.watcher, ...(partial.watcher ?? {}) },
    environment: { ...(partial.environment ?? {}) },
    addonEntries: Array.isArray(partial.addonEntries) ? partial.addonEntries : []
  };
}

async function persistConfig() {
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function normalizeAddonEntry(entry) {
  const sourceDir = path.resolve(String(entry.sourceDir ?? ""));
  const loadDir = path.resolve(String(entry.loadDir ?? entry.sourceDir ?? ""));
  const moduleName =
    entry.moduleName && entry.moduleName !== "auto"
      ? String(entry.moduleName)
      : path.basename(loadDir);

  return {
    sourceDir,
    loadDir,
    moduleName
  };
}

function getNormalizedAddons() {
  return config.addonEntries.map(normalizeAddonEntry).filter((entry) => entry.sourceDir && entry.loadDir && entry.moduleName);
}

function collectWatchRoots() {
  return [...new Set(getNormalizedAddons().map((entry) => entry.sourceDir))];
}

function setupWatcher() {
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  const roots = collectWatchRoots();
  if (!config.watcher.enabled || roots.length === 0) {
    logLine("warn", "Watcher disabled or no addon roots configured.", { enabled: config.watcher.enabled, roots });
    emit("watcher_state", { running: false, roots });
    return;
  }

  watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    ignored: config.watcher.ignoredGlobs
  });

  const onChange = (eventName, changedPath) => {
    logLine("info", "File change detected.", { eventName, path: changedPath });
    emit("file_change", { eventName, path: changedPath });
    scheduleReload("watcher-change", changedPath);
  };

  watcher.on("add", (changedPath) => onChange("add", changedPath));
  watcher.on("change", (changedPath) => onChange("change", changedPath));
  watcher.on("unlink", (changedPath) => onChange("unlink", changedPath));
  watcher.on("error", (error) => {
    logLine("error", "Watcher error", String(error));
  });

  logLine("info", "Watcher started.", { roots, ignored: config.watcher.ignoredGlobs });
  emit("watcher_state", { running: true, roots, ignored: config.watcher.ignoredGlobs });
}

function scheduleReload(reason, changedPath = null) {
  if (typeof changedPath === "string" && changedPath !== "") {
    pendingChangedPaths.add(path.resolve(changedPath));
  }
  const debounceMs = Number(config.watcher.debounceMs || debounceMsDefault);
  if (reloadTimer) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void performReload(reason);
  }, debounceMs);
}

async function runPreReloadCommand() {
  const command = String(config.preReloadCommand ?? "").trim();
  if (!command) {
    return;
  }
  logLine("info", "Running pre-reload command", command);
  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: repoRoot,
      shell: true,
      env: process.env
    });
    child.stdout.on("data", (chunk) => logLine("info", "[build stdout]", chunk.toString().trimEnd()));
    child.stderr.on("data", (chunk) => logLine("warn", "[build stderr]", chunk.toString().trimEnd()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Pre-reload command failed with exit code ${code}`));
      }
    });
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
}

async function ping(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(700) });
  return response.ok;
}

async function getBlenderInstallCandidates() {
  const candidates = new Set();
  if (process.platform === "win32") {
    const baseDirs = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Blender Foundation"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Blender Foundation")
    ];
    for (const baseDir of baseDirs) {
      try {
        const children = await fsp.readdir(baseDir, { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory()) continue;
          const exePath = path.join(baseDir, child.name, "blender.exe");
          if (fs.existsSync(exePath)) {
            candidates.add(exePath);
          }
        }
      } catch {
        // best-effort scan
      }
    }
    try {
      const { stdout } = await execAsync("where blender");
      for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        if (line.toLowerCase().endsWith("blender.exe")) {
          candidates.add(line);
        }
      }
    } catch {
      // best-effort scan
    }
  } else {
    try {
      const { stdout } = await execAsync("which blender");
      for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        candidates.add(line);
      }
    } catch {
      // best-effort scan
    }
  }
  return [...candidates].sort();
}

async function getRunningBlenderServerCandidates() {
  if (process.platform !== "win32") {
    return [];
  }
  const pids = new Set();
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq blender.exe" /FO CSV /NH');
    for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const match = line.match(/^"[^"]+","(\d+)"/);
      if (match) {
        pids.add(Number(match[1]));
      }
    }
  } catch {
    return [];
  }
  if (pids.size === 0) {
    return [];
  }

  const ports = new Set();
  try {
    const { stdout } = await execAsync("netstat -ano -p tcp");
    const lines = stdout.split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = lineRaw.trim().replace(/\s+/g, " ");
      if (!line.startsWith("TCP ")) continue;
      const parts = line.split(" ");
      if (parts.length < 5) continue;
      const localAddress = parts[1];
      const state = parts[3];
      const pid = Number(parts[4]);
      if (!pids.has(pid)) continue;
      if (state !== "LISTENING") continue;
      const portPart = localAddress.split(":").at(-1);
      const port = Number(portPart);
      if (Number.isFinite(port) && port > 0) {
        ports.add(port);
      }
    }
  } catch {
    return [];
  }

  const found = [];
  const sortedPorts = [...ports].sort((a, b) => a - b);
  for (const port of sortedPorts) {
    const address = `http://127.0.0.1:${port}`;
    try {
      const ok = await ping(`${address}/ping`);
      if (ok) {
        found.push({ host: "127.0.0.1", blenderPort: port, address });
      }
    } catch {
      // not the addon server
    }
  }
  return found;
}

async function pickFolder(initialDirectory = "") {
  if (process.platform !== "win32") {
    throw new Error("Folder picker is currently implemented for Windows only.");
  }
  const normalized = String(initialDirectory || "").replace(/\\/g, "\\\\").replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.ShowNewFolderButton = $true",
    normalized ? `$dialog.SelectedPath = '${normalized}'` : "",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "}"
  ].filter(Boolean).join("; ");
  const { stdout } = await execAsync(`powershell -NoProfile -Command "${script}"`);
  return stdout.trim();
}

function getActiveBlenderAddress() {
  if (config.mode === "attach") {
    const host = config.attach.host || "127.0.0.1";
    const port = Number(config.attach.blenderPort);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error("Attach mode requires a valid blenderPort");
    }
    return `http://${host}:${port}`;
  }
  if (!activeInstance?.blenderPort) {
    throw new Error("No active Blender instance connected yet");
  }
  return `http://127.0.0.1:${activeInstance.blenderPort}`;
}

async function ensureAttachAddressReady() {
  const configuredHost = config.attach.host || "127.0.0.1";
  const configuredPort = Number(config.attach.blenderPort);
  if (!Number.isFinite(configuredPort) || configuredPort <= 0) {
    throw new Error("Attach mode requires a valid blenderPort");
  }

  const configuredAddress = `http://${configuredHost}:${configuredPort}`;
  try {
    const ok = await ping(`${configuredAddress}/ping`);
    if (ok) {
      return configuredAddress;
    }
  } catch {
    // fall through and try recovery scan
  }

  logLine("warn", "Configured attached Blender is unreachable. Scanning for a replacement instance...", { configuredAddress });
  const instances = await getRunningBlenderServerCandidates();
  if (instances.length === 1) {
    const replacement = instances[0];
    config.attach = { host: replacement.host, blenderPort: replacement.blenderPort };
    await persistConfig();
    activeInstance = {
      blenderPort: replacement.blenderPort,
      debugpyPort: 0,
      blenderPath: "",
      scriptsFolder: "",
      vscodeIdentifier: "attach"
    };
    emit("instance_state", { connected: true, instance: activeInstance });
    logLine("info", "Recovered attach target automatically.", replacement);
    return replacement.address;
  }
  if (instances.length === 0) {
    throw new Error(`Attached Blender is unreachable (${configuredAddress}) and no running attachable Blender instances were found.`);
  }
  throw new Error(`Attached Blender is unreachable (${configuredAddress}) and multiple running instances were found. Re-attach manually.`);
}

function getAddonsForChangedPaths(allAddons, changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return allAddons;
  }

  const matched = allAddons.filter((addon) => {
    const addonRoot = path.resolve(addon.sourceDir);
    return changedPaths.some((changedPath) => {
      const relative = path.relative(addonRoot, changedPath);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  });

  return matched.length > 0 ? matched : allAddons;
}

async function performReload(reason = "manual") {
  if (isReloading) {
    pendingReload = true;
    return;
  }
  isReloading = true;
  emit("reload_state", { running: true, reason });
  try {
    await runPreReloadCommand();
    const allAddons = getNormalizedAddons();
    if (allAddons.length === 0) {
      throw new Error("No addon entries configured");
    }
    const changedPathsSnapshot = [...pendingChangedPaths];
    pendingChangedPaths = new Set();
    const targetAddons = reason === "watcher-change"
      ? getAddonsForChangedPaths(allAddons, changedPathsSnapshot)
      : allAddons;
    const names = targetAddons.map((item) => item.moduleName);
    const dirs = targetAddons.map((item) => item.sourceDir);
    const address = config.mode === "attach"
      ? await ensureAttachAddressReady()
      : getActiveBlenderAddress();
    await postJson(address, { type: "reload", names, dirs });
    logLine("info", "Reload sent", { reason, address, names, changedPaths: changedPathsSnapshot });
  } catch (error) {
    logLine("error", "Reload failed", String(error));
  } finally {
    isReloading = false;
    emit("reload_state", { running: false, reason });
    if (pendingReload) {
      pendingReload = false;
      scheduleReload("queued");
    }
  }
}

function getBlenderEnv(recoveryBlendPath = null) {
  const addonsToLoad = getNormalizedAddons().map((entry) => ({
    load_dir: entry.loadDir,
    module_name: entry.moduleName
  }));
  return {
    ...process.env,
    ...config.environment,
    ADDONS_TO_LOAD: JSON.stringify(addonsToLoad),
    VSCODE_EXTENSIONS_REPOSITORY: "vscode_development",
    VSCODE_LOG_LEVEL: "debug",
    VSCODE_WAIT_FOR_DEBUGGER: "0",
    EDITOR_PORT: String(editorPort),
    VSCODE_IDENTIFIER: "standalone-service",
    BLENDER_VSCODE_RECOVERY_BLEND: recoveryBlendPath ? String(recoveryBlendPath) : ""
  };
}

async function startBlender(recoveryBlendPath = null) {
  if (blenderProcess) {
    throw new Error("Blender process already running");
  }
  if (!config.blenderExecutable) {
    throw new Error("Set blenderExecutable in config first");
  }
  const args = ["--python", launchPyPath, ...config.blenderArgs];
  const env = getBlenderEnv(recoveryBlendPath);

  blenderStopRequested = false;
  blenderCrashSuspected = false;
  blenderProcess = spawn(config.blenderExecutable, args, {
    cwd: repoRoot,
    env
  });

  blenderProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString().trimEnd();
    updateCrashContextFromLog(text);
    if (detectCrashFromLog(text)) {
      blenderCrashSuspected = true;
      logLine("warn", "Crash signature detected in Blender stdout.");
    }
    logBlender("info", "[stdout]", text);
  });
  blenderProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString().trimEnd();
    updateCrashContextFromLog(text);
    if (detectCrashFromLog(text)) {
      blenderCrashSuspected = true;
      logLine("warn", "Crash signature detected in Blender stderr.");
    }
    logBlender("warn", "[stderr]", text);
  });
  blenderProcess.on("error", (error) => {
    logLine("error", "Blender process error", String(error));
  });
  blenderProcess.on("close", async (code, signal) => {
    logLine("info", "Blender process exited", { code, signal });
    blenderProcess = null;
    activeInstance = null;
    emit("instance_state", { connected: false, instance: null });
    const shouldRestart = config.mode === "launch"
      && config.autoRestartOnCrash
      && !blenderStopRequested
      && (blenderCrashSuspected || code !== 0);
    if (shouldRestart) {
      restartAttempt += 1;
      const waitMs = Math.min(1500 * restartAttempt, 8000);
      logLine("warn", "Auto-restart on crash is enabled. Restarting Blender...", { waitMs, restartAttempt });
      emit("auto_restart", { waitMs, restartAttempt });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        let recoveryBlendPath = null;
        if (config.openLatestAutosaveOnCrash) {
          recoveryBlendPath = await findLatestRecoveryBlend();
          if (recoveryBlendPath) {
            logLine("info", "Opening latest recovery/autosave file after crash.", { recoveryBlendPath });
          } else {
            logLine("warn", "Auto-restart could not find a recovery/autosave .blend file.");
          }
        }
        await startBlender(recoveryBlendPath);
      } catch (error) {
        logLine("error", "Auto-restart failed", String(error));
      }
    } else {
      restartAttempt = 0;
    }
  });

  logLine("info", "Blender process started", { executable: config.blenderExecutable, args });
}

function stopBlender() {
  if (!blenderProcess) {
    return;
  }
  blenderStopRequested = true;
  blenderProcess.kill();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: config.mode,
    hasProcess: Boolean(blenderProcess),
    activeInstance
  });
});

app.get("/api/config", (_req, res) => {
  res.json(config);
});

app.put("/api/config", async (req, res) => {
  config = mergeConfig(req.body ?? {});
  await persistConfig();
  setupWatcher();
  emit("config_updated", { config });
  res.json(config);
});

app.post("/api/reload", async (_req, res) => {
  await performReload("manual-api");
  res.json({ ok: true });
});

app.post("/api/blender/start", async (_req, res) => {
  try {
    config.mode = "launch";
    await persistConfig();
    await startBlender();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.post("/api/blender/stop", (_req, res) => {
  stopBlender();
  res.json({ ok: true });
});

app.post("/api/blender/attach", async (req, res) => {
  const host = String(req.body?.host ?? "127.0.0.1");
  const blenderPort = Number(req.body?.blenderPort);
  if (!Number.isFinite(blenderPort) || blenderPort <= 0) {
    res.status(400).json({ ok: false, error: "blenderPort must be a positive number" });
    return;
  }
  try {
    const address = `http://${host}:${blenderPort}`;
    const reachable = await ping(`${address}/ping`);
    if (!reachable) {
      throw new Error("Blender ping failed");
    }
    let logForwardingReady = true;
    try {
      await postJson(address, {
        type: "setEditorAddress",
        editorAddress: `http://127.0.0.1:${editorPort}`,
        forwardLogs: true
      });
    } catch {
      logForwardingReady = false;
      logLine("warn", "Attached Blender does not support dynamic log forwarding setup yet.");
    }
    config.mode = "attach";
    config.attach = { host, blenderPort };
    await persistConfig();
    activeInstance = {
      blenderPort,
      debugpyPort: 0,
      blenderPath: "",
      scriptsFolder: "",
      vscodeIdentifier: "attach"
    };
    emit("instance_state", { connected: true, instance: activeInstance });
    res.json({ ok: true, logForwardingReady });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.get("/api/blender/install-scan", async (_req, res) => {
  const installs = await getBlenderInstallCandidates();
  res.json({ installs });
});

app.get("/api/blender/running-scan", async (_req, res) => {
  const instances = await getRunningBlenderServerCandidates();
  res.json({ instances });
});

app.post("/api/system/pick-folder", async (req, res) => {
  try {
    const selectedPath = await pickFolder(String(req.body?.initialPath ?? ""));
    res.json({ path: selectedPath || "" });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
  req.on("close", () => {
    clients.delete(res);
  });
});

// Endpoint Blender Python addon uses to communicate with editor service.
app.post("/", (req, res) => {
  const payload = req.body ?? {};
  const type = typeof payload.type === "string" ? payload.type : "";

  switch (type) {
    case "setup": {
      activeInstance = {
        blenderPort: Number(payload.blenderPort),
        debugpyPort: Number(payload.debugpyPort),
        blenderPath: String(payload.blenderPath ?? ""),
        scriptsFolder: String(payload.scriptsFolder ?? ""),
        vscodeIdentifier: String(payload.vscodeIdentifier ?? "")
      };
      logLine("info", "Blender connected", activeInstance);
      emit("instance_state", { connected: true, instance: activeInstance });
      res.json({ ok: true });
      return;
    }
    case "enableFailure":
    case "disableFailure": {
      logLine("error", "Addon reload failure", payload);
      res.json({ ok: true });
      return;
    }
    case "addonUpdated": {
      logLine("info", "Addon updated");
      res.json({ ok: true });
      return;
    }
    case "blenderLog": {
      const rawLevel = typeof payload.level === "string" ? payload.level : "info";
      const level = rawLevel === "warning" ? "warn" : rawLevel;
      const message = typeof payload.message === "string" ? payload.message : "";
      const logger = typeof payload.logger === "string" ? payload.logger : undefined;
      logBlender(level, message, logger ? { logger } : undefined);
      res.json({ ok: true });
      return;
    }
    default: {
      logLine("warn", "Unknown Blender event", payload);
      res.status(400).json({ ok: false, error: "unknown event type" });
    }
  }
});

if (fs.existsSync(frontendDist)) {
  app.use("/", express.static(frontendDist));
}

await ensureConfig();
setupWatcher();

app.listen(editorPort, () => {
  logLine("info", `Editor bridge listening on ${editorPort}`);
});
app.listen(webPort, () => {
  logLine("info", `Control page/API listening on ${webPort}`);
});
