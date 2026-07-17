const SERVER_URL = "ws://127.0.0.1:18765";
const RECONNECT_ALARM = "chrome-mcp-reconnect";
const HEARTBEAT_MS = 20000;
const RECONNECT_MS = 15000;
const RECONNECT_ALARM_MINUTES = 0.5;
const MAX_CDP_EVENTS = 500;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let connected = false;
let lastError = null;
let cdpEventSequence = 0;
const cdpEvents = [];
const attachedDebuggees = new Map();

async function setStatus(nextConnected, error = null) {
  connected = nextConnected;
  lastError = error;
  await chrome.storage.local.set({
    connected,
    serverUrl: SERVER_URL,
    lastError,
    updatedAt: new Date().toISOString()
  });
}

function scheduleReconnect() {
  stopHeartbeat();
  void setStatus(false, lastError);
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(SERVER_URL);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    lastError = null;
    send({ type: "hello", role: "extension" });
    void setStatus(true);
    startHeartbeat();
  });

  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    lastError = `Could not connect to ${SERVER_URL}`;
    scheduleReconnect();
  });

  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (!message || message.type !== "request" || !message.id) return;

    try {
      const result = await handleRequest(message);
      send({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      send({
        type: "response",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({ type: "heartbeat", time: Date.now() });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function handleRequest(message) {
  const { method, params = {} } = message;

  switch (method) {
    case "tabs.list":
      return listTabs();
    case "tabs.open":
      return openTab(params.url, params.active);
    case "tabs.activate":
      return activateTab(params.tabId);
    case "tabs.close":
      return closeTab(params.tabId);
    case "page.info":
      return pageInfo(params.tabId);
    case "page.text":
      return sendToTab(params.tabId, { action: "page.text" });
    case "page.click":
      return sendToTab(params.tabId, { action: "page.click", selector: params.selector });
    case "page.type":
      return sendToTab(params.tabId, {
        action: "page.type",
        selector: params.selector,
        text: params.text,
        clear: params.clear !== false
      });
    case "page.script":
      return executeScript(params.tabId, params.script);
    case "cdp.targets":
      return cdpTargets();
    case "cdp.protocol":
      return cdpProtocol(params);
    case "cdp.attached":
      return cdpAttached();
    case "cdp.attach":
      return cdpAttach(params);
    case "cdp.detach":
      return cdpDetach(params);
    case "cdp.send":
      return cdpSend(params);
    case "cdp.events":
      return cdpPollEvents(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(serializeTab);
}

async function openTab(url, active = true) {
  if (!url) throw new Error("url is required");
  const tab = await chrome.tabs.create({ url, active });
  return serializeTab(tab);
}

async function activateTab(tabId) {
  const id = requireTabId(tabId);
  const tab = await chrome.tabs.update(id, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return serializeTab(tab);
}

async function closeTab(tabId) {
  const id = requireTabId(tabId);
  await chrome.tabs.remove(id);
  return { closed: true, tabId: id };
}

async function pageInfo(tabId) {
  const tab = await getTargetTab(tabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      contentType: document.contentType,
      language: document.documentElement.lang || null,
      selection: window.getSelection()?.toString() || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    })
  });
  return { tab: serializeTab(tab), page: result?.result ?? null };
}

async function sendToTab(tabId, payload) {
  const tab = await getTargetTab(tabId);
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch (error) {
    throw new Error(`Could not reach content script on tab ${tab.id}: ${error.message}`);
  }
}

async function executeScript(tabId, script) {
  if (!script) throw new Error("script is required");
  const tab = await getTargetTab(tabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (source) => {
      const fn = new Function(`return (${source});`);
      const value = fn();
      return Promise.resolve(value);
    },
    args: [script]
  });
  return result?.result ?? null;
}

async function cdpTargets() {
  const targets = await chrome.debugger.getTargets();
  return targets.map((target) => ({
    id: target.id,
    tabId: target.tabId,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
    faviconUrl: target.faviconUrl
  }));
}

async function cdpProtocol(params) {
  return cdpSend({
    ...params,
    command: "Schema.getDomains",
    params: {},
    autoAttach: true
  });
}

function cdpAttached() {
  return Array.from(attachedDebuggees.values());
}

async function cdpAttach(params) {
  const debuggee = await makeDebuggee(params, { defaultActiveTab: true });
  const protocolVersion = params.protocolVersion || "1.3";
  const key = debuggeeKey(debuggee);
  if (attachedDebuggees.has(key)) {
    return { attached: true, alreadyAttached: true, ...attachedDebuggees.get(key) };
  }
  await chrome.debugger.attach(debuggee, protocolVersion);
  const record = {
    key,
    debuggee,
    protocolVersion,
    attachedAt: new Date().toISOString()
  };
  attachedDebuggees.set(key, record);
  return { attached: true, ...record };
}

async function cdpDetach(params) {
  const debuggee = await makeDebuggee(params, { defaultActiveTab: false });
  const key = debuggeeKey(debuggee);
  await chrome.debugger.detach(debuggee);
  attachedDebuggees.delete(key);
  return { detached: true, debuggee, key };
}

async function cdpSend(params) {
  if (!params.command) throw new Error("command is required");
  const debuggee = await makeDebuggee(params, { defaultActiveTab: true });
  if (params.autoAttach !== false && !attachedDebuggees.has(debuggeeKey(debuggee))) {
    await cdpAttach(params);
  }
  const result = await chrome.debugger.sendCommand(debuggee, params.command, params.params || {});
  if (params.detach === true) {
    await cdpDetach(params);
  }
  return result ?? {};
}

function cdpPollEvents(params = {}) {
  const limit = Math.max(0, Math.min(Number(params.limit ?? 100), MAX_CDP_EVENTS));
  const debuggee = makeDebuggeeSync(params);
  const key = debuggee ? debuggeeKey(debuggee) : null;
  const method = params.method ? String(params.method) : null;
  const events = cdpEvents
    .filter((event) => (!key || event.key === key) && (!method || event.method === method))
    .slice(-limit);

  if (params.clear === true) {
    if (key || method) {
      for (let index = cdpEvents.length - 1; index >= 0; index -= 1) {
        const event = cdpEvents[index];
        if ((!key || event.key === key) && (!method || event.method === method)) {
          cdpEvents.splice(index, 1);
        }
      }
    } else {
      cdpEvents.length = 0;
    }
  }

  return { events, buffered: cdpEvents.length };
}

async function makeDebuggee(params = {}, options = { defaultActiveTab: false }) {
  const debuggee = makeDebuggeeSync(params);
  if (debuggee) return debuggee;
  if (options.defaultActiveTab) {
    const tab = await getTargetTab(params.tabId);
    return { tabId: tab.id };
  }
  throw new Error("tabId, targetId, or extensionId is required");
}

function makeDebuggeeSync(params = {}) {
  const hasTabId = params.tabId !== undefined && params.tabId !== null;
  const hasTargetId = Boolean(params.targetId);
  const hasExtensionId = Boolean(params.extensionId);

  if ([hasTabId, hasTargetId, hasExtensionId].filter(Boolean).length > 1) {
    throw new Error("Provide only one of tabId, targetId, or extensionId");
  }

  if (hasTabId) return { tabId: requireTabId(params.tabId) };
  if (hasTargetId) return { targetId: String(params.targetId) };
  if (hasExtensionId) return { extensionId: String(params.extensionId) };

  return null;
}

async function getTargetTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    const tab = await chrome.tabs.get(requireTabId(tabId));
    if (!tab.id) throw new Error(`Tab not found: ${tabId}`);
    return tab;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

function requireTabId(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw new Error("tabId must be an integer");
  return id;
}

function serializeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    pinned: tab.pinned,
    title: tab.title,
    url: tab.url,
    status: tab.status,
    favIconUrl: tab.favIconUrl
  };
}

function debuggeeKey(debuggee) {
  if (debuggee.tabId !== undefined) return `tab:${debuggee.tabId}`;
  if (debuggee.targetId !== undefined) return `target:${debuggee.targetId}`;
  if (debuggee.extensionId !== undefined) return `extension:${debuggee.extensionId}`;
  return JSON.stringify(debuggee);
}

function recordCdpEvent(debuggee, method, params) {
  const key = debuggeeKey(debuggee);
  cdpEvents.push({
    sequence: ++cdpEventSequence,
    time: new Date().toISOString(),
    key,
    debuggee,
    method,
    params: params ?? {}
  });

  if (cdpEvents.length > MAX_CDP_EVENTS) {
    cdpEvents.splice(0, cdpEvents.length - MAX_CDP_EVENTS);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "status") {
    sendResponse({ connected, serverUrl: SERVER_URL, lastError });
    return false;
  }

  if (message?.action === "reconnect") {
    if (socket) {
      socket.close();
      socket = null;
    }
    connect();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

chrome.debugger.onEvent.addListener((debuggee, method, params) => {
  recordCdpEvent(debuggee, method, params);
});

chrome.debugger.onDetach.addListener((debuggee, reason) => {
  const key = debuggeeKey(debuggee);
  attachedDebuggees.delete(key);
  recordCdpEvent(debuggee, "Debugger.detached", { reason });
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_MINUTES });
  connect();
});

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_MINUTES });
connect();
