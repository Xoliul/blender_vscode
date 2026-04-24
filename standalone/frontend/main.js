const logsEl = document.querySelector("#logs");
const connectionEl = document.querySelector("#connection-state");
const blenderExeEl = document.querySelector("#blender-exe");
const blenderArgsEl = document.querySelector("#blender-args");
const watchDebounceEl = document.querySelector("#watch-debounce");
const preReloadEl = document.querySelector("#pre-reload-cmd");
const autoRestartCrashEl = document.querySelector("#auto-restart-crash");
const openAutosaveOnCrashEl = document.querySelector("#open-autosave-on-crash");
const addonRowsEl = document.querySelector("#addon-rows");
const attachHostEl = document.querySelector("#attach-host");
const attachPortEl = document.querySelector("#attach-port");
const installsSelectEl = document.querySelector("#installs-select");
const runningSelectEl = document.querySelector("#running-select");
const tabServiceEl = document.querySelector("#tab-service");
const tabBlenderEl = document.querySelector("#tab-blender");

const logBuffers = {
  service: [],
  blender: []
};
let activeLogTab = "service";
const maxLogLinesPerTab = 2000;

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function formatLogDetails(details) {
  if (details === undefined || details === null) {
    return "";
  }
  if (typeof details === "string") {
    return stripAnsi(details)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trimEnd();
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function appendLog(text) {
  appendLogToTab("service", text);
}

function appendLogToTab(tab, text) {
  if (!logBuffers[tab]) {
    return;
  }
  const lines = String(text).split("\n");
  for (const line of lines) {
    logBuffers[tab].push(line);
  }
  if (logBuffers[tab].length > maxLogLinesPerTab) {
    logBuffers[tab].splice(0, logBuffers[tab].length - maxLogLinesPerTab);
  }
  if (tab === activeLogTab) {
    renderActiveLogTab();
  }
}

function renderActiveLogTab() {
  logsEl.textContent = `${logBuffers[activeLogTab].join("\n")}${logBuffers[activeLogTab].length > 0 ? "\n" : ""}`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setActiveLogTab(tab) {
  activeLogTab = tab;
  tabServiceEl.classList.toggle("active", tab === "service");
  tabBlenderEl.classList.toggle("active", tab === "blender");
  renderActiveLogTab();
}

function setConnectionState(text, kind) {
  connectionEl.textContent = text;
  connectionEl.classList.remove("status-connected", "status-disconnected", "status-connecting");
  if (kind === "connected") {
    connectionEl.classList.add("status-connected");
  } else if (kind === "connecting") {
    connectionEl.classList.add("status-connecting");
  } else {
    connectionEl.classList.add("status-disconnected");
  }
}

function setSelectOptions(selectEl, options, emptyLabel) {
  selectEl.innerHTML = "";
  if (options.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    selectEl.appendChild(option);
    return;
  }
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    selectEl.appendChild(option);
  }
}

function createAddonRow(entry = { sourceDir: "", loadDir: "", moduleName: "auto" }) {
  const wrapper = document.createElement("div");
  wrapper.className = "addon-row";
  wrapper.innerHTML = `
    <div class="addon-row-grid">
      <div>
        <div class="path-input-wrap">
          <input data-field="sourceDir" placeholder="Source dir (watched)" />
          <button data-action="browse-source" type="button" class="btn-icon" title="Browse source">📁</button>
        </div>
      </div>
      <div>
        <div class="path-input-wrap">
          <input data-field="loadDir" placeholder="Load dir (Blender loads from)" />
          <button data-action="browse-load" type="button" class="btn-icon" title="Browse load">📁</button>
        </div>
      </div>
      <input data-field="moduleName" placeholder="moduleName (auto)" />
      <button data-action="remove" type="button">🗑️ Remove</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button data-action="paste-same" type="button" class="btn-compact">🔁 Source = Load</button>
      <button data-action="copy-source" type="button" class="btn-compact">↩️ Load = Source</button>
      <span></span>
    </div>
  `;
  wrapper.querySelector('[data-field="sourceDir"]').value = entry.sourceDir || "";
  wrapper.querySelector('[data-field="loadDir"]').value = entry.loadDir || "";
  wrapper.querySelector('[data-field="moduleName"]').value = entry.moduleName || "auto";

  wrapper.querySelector('[data-action="remove"]').addEventListener("click", () => {
    wrapper.remove();
  });
  wrapper.querySelector('[data-action="paste-same"]').addEventListener("click", () => {
    const sourceEl = wrapper.querySelector('[data-field="sourceDir"]');
    const loadEl = wrapper.querySelector('[data-field="loadDir"]');
    const current = sourceEl.value || loadEl.value;
    sourceEl.value = current;
    loadEl.value = current;
  });
  wrapper.querySelector('[data-action="copy-source"]').addEventListener("click", () => {
    const sourceEl = wrapper.querySelector('[data-field="sourceDir"]');
    const loadEl = wrapper.querySelector('[data-field="loadDir"]');
    loadEl.value = sourceEl.value;
  });
  wrapper.querySelector('[data-action="browse-source"]').addEventListener("click", async () => {
    const sourceEl = wrapper.querySelector('[data-field="sourceDir"]');
    try {
      const result = await api("/api/system/pick-folder", "POST", { initialPath: sourceEl.value.trim() });
      if (result.path) {
        sourceEl.value = result.path;
      }
    } catch (error) {
      appendLog(`Browse source failed: ${String(error)}`);
    }
  });
  wrapper.querySelector('[data-action="browse-load"]').addEventListener("click", async () => {
    const loadEl = wrapper.querySelector('[data-field="loadDir"]');
    try {
      const result = await api("/api/system/pick-folder", "POST", { initialPath: loadEl.value.trim() });
      if (result.path) {
        loadEl.value = result.path;
      }
    } catch (error) {
      appendLog(`Browse load failed: ${String(error)}`);
    }
  });

  return wrapper;
}

function getAddonEntriesFromUi() {
  const entries = [];
  const rows = addonRowsEl.querySelectorAll(".addon-row");
  for (const row of rows) {
    const sourceDir = row.querySelector('[data-field="sourceDir"]').value.trim();
    const loadDir = row.querySelector('[data-field="loadDir"]').value.trim();
    const moduleName = row.querySelector('[data-field="moduleName"]').value.trim() || "auto";
    if (!sourceDir || !loadDir) {
      continue;
    }
    entries.push({ sourceDir, loadDir, moduleName });
  }
  return entries;
}

function setAddonEntriesInUi(entries) {
  addonRowsEl.innerHTML = "";
  const rows = Array.isArray(entries) && entries.length > 0 ? entries : [{ sourceDir: "", loadDir: "", moduleName: "auto" }];
  for (const entry of rows) {
    addonRowsEl.appendChild(createAddonRow(entry));
  }
}

async function api(path, method = "GET", body = undefined) {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function loadConfig() {
  const config = await api("/api/config");
  blenderExeEl.value = config.blenderExecutable || "";
  blenderArgsEl.value = JSON.stringify(config.blenderArgs || []);
  watchDebounceEl.value = String(config.watcher?.debounceMs || 250);
  preReloadEl.value = config.preReloadCommand || "";
  autoRestartCrashEl.checked = Boolean(config.autoRestartOnCrash);
  openAutosaveOnCrashEl.checked = config.openLatestAutosaveOnCrash !== false;
  setAddonEntriesInUi(config.addonEntries || []);
}

async function saveConfig() {
  const current = await api("/api/config");
  const next = {
    ...current,
    blenderExecutable: blenderExeEl.value.trim(),
    blenderArgs: JSON.parse(blenderArgsEl.value || "[]"),
    preReloadCommand: preReloadEl.value.trim(),
    autoRestartOnCrash: autoRestartCrashEl.checked,
    openLatestAutosaveOnCrash: openAutosaveOnCrashEl.checked,
    watcher: {
      ...current.watcher,
      debounceMs: Number(watchDebounceEl.value || "250")
    },
    addonEntries: getAddonEntriesFromUi()
  };
  await api("/api/config", "PUT", next);
  appendLog("Config saved.");
}

document.querySelector("#save-config-btn").addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    appendLog(`Save failed: ${String(error)}`);
  }
});

document.querySelector("#start-btn").addEventListener("click", async () => {
  try {
    await api("/api/blender/start", "POST");
    appendLog("Start requested.");
  } catch (error) {
    appendLog(`Start failed: ${String(error)}`);
  }
});

document.querySelector("#stop-btn").addEventListener("click", async () => {
  try {
    await api("/api/blender/stop", "POST");
    appendLog("Stop requested.");
  } catch (error) {
    appendLog(`Stop failed: ${String(error)}`);
  }
});

document.querySelector("#reload-btn").addEventListener("click", async () => {
  try {
    await api("/api/reload", "POST");
    appendLog("Reload requested.");
  } catch (error) {
    appendLog(`Reload failed: ${String(error)}`);
  }
});

document.querySelector("#attach-btn").addEventListener("click", async () => {
  try {
    setConnectionState("Connecting...", "connecting");
    const result = await api("/api/blender/attach", "POST", {
      host: attachHostEl.value.trim() || "127.0.0.1",
      blenderPort: Number(attachPortEl.value)
    });
    appendLog("Attach successful.");
    if (result.logForwardingReady === false) {
      appendLog("Warning: attached instance does not support forwarded Blender logs yet. Reload addon/restart Blender with latest addon code.");
    }
  } catch (error) {
    setConnectionState("Disconnected", "disconnected");
    appendLog(`Attach failed: ${String(error)}`);
  }
});

async function scanInstalls(auto = false) {
  try {
    const data = await api("/api/blender/install-scan");
    const installs = (data.installs || []).map((item) => ({ value: item, label: item }));
    setSelectOptions(installsSelectEl, installs, "No installs found");
    appendLog(`Install scan complete: ${installs.length} found.${auto ? " (auto)" : ""}`);
  } catch (error) {
    appendLog(`Install scan failed: ${String(error)}`);
  }
}

document.querySelector("#scan-installs-btn").addEventListener("click", async () => {
  await scanInstalls(false);
});

document.querySelector("#use-install-btn").addEventListener("click", () => {
  const value = installsSelectEl.value.trim();
  if (!value) {
    appendLog("No install selected.");
    return;
  }
  blenderExeEl.value = value;
  appendLog(`Selected install applied: ${value}`);
});

async function scanRunning(auto = false) {
  try {
    const data = await api("/api/blender/running-scan");
    const instances = (data.instances || []).map((item) => ({
      value: `${item.host}:${item.blenderPort}`,
      label: `${item.host}:${item.blenderPort}`
    }));
    setSelectOptions(runningSelectEl, instances, "No running attachable Blender found");
    appendLog(`Running scan complete: ${instances.length} attachable instance(s).${auto ? " (auto)" : ""}`);
    if (instances.length === 1) {
      const [host, portText] = instances[0].value.split(":");
      setConnectionState("Connecting...", "connecting");
      await api("/api/blender/attach", "POST", { host, blenderPort: Number(portText) });
      attachHostEl.value = host;
      attachPortEl.value = portText;
      appendLog(`Auto-attached single detected instance ${instances[0].value}.`);
    }
  } catch (error) {
    if (auto) {
      setConnectionState("Disconnected", "disconnected");
    }
    appendLog(`Running scan failed: ${String(error)}`);
  }
}

document.querySelector("#scan-running-btn").addEventListener("click", async () => {
  await scanRunning(false);
});

document.querySelector("#attach-selected-btn").addEventListener("click", async () => {
  const value = runningSelectEl.value.trim();
  if (!value) {
    appendLog("No running instance selected.");
    return;
  }
  const [host, portText] = value.split(":");
  try {
    setConnectionState("Connecting...", "connecting");
    const result = await api("/api/blender/attach", "POST", {
      host,
      blenderPort: Number(portText)
    });
    attachHostEl.value = host;
    attachPortEl.value = portText;
    appendLog(`Attached selected instance ${value}.`);
    if (result.logForwardingReady === false) {
      appendLog("Warning: attached instance does not support forwarded Blender logs yet. Reload addon/restart Blender with latest addon code.");
    }
  } catch (error) {
    setConnectionState("Disconnected", "disconnected");
    appendLog(`Attach selected failed: ${String(error)}`);
  }
});

document.querySelector("#addons-example-btn").addEventListener("click", () => {
  setAddonEntriesInUi([
    {
      sourceDir: "G:/Code/my_addon",
      loadDir: "G:/Code/my_addon",
      moduleName: "auto"
    }
  ]);
  appendLog("Inserted addon example row.");
});

document.querySelector("#add-addon-row-btn").addEventListener("click", () => {
  addonRowsEl.appendChild(createAddonRow({ sourceDir: "", loadDir: "", moduleName: "auto" }));
});

document.querySelector("#clear-logs-btn").addEventListener("click", () => {
  logBuffers[activeLogTab] = [];
  renderActiveLogTab();
});

tabServiceEl.addEventListener("click", () => setActiveLogTab("service"));
tabBlenderEl.addEventListener("click", () => setActiveLogTab("blender"));

function connectEvents() {
  const events = new EventSource("/api/events");
  events.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "instance_state") {
      setConnectionState(payload.connected ? "Connected" : "Disconnected", payload.connected ? "connected" : "disconnected");
    }
    if (payload.type === "log") {
      const tab = payload.stream === "blender" ? "blender" : "service";
      const detailsText = formatLogDetails(payload.details);
      const base = `${payload.timestamp} [${payload.level}] ${payload.message}`;
      const rendered = detailsText ? `${base}\n${detailsText}` : base;
      appendLogToTab(tab, rendered);
      return;
    }
    appendLogToTab("service", `${payload.timestamp} ${payload.type}`);
  };
  events.onerror = () => {
    setConnectionState("Disconnected", "disconnected");
    appendLogToTab("service", "Event stream disconnected. Retrying automatically...");
  };
}

await loadConfig();
connectEvents();
setConnectionState("Disconnected", "disconnected");
setActiveLogTab("service");
await Promise.allSettled([scanInstalls(true), scanRunning(true)]);
