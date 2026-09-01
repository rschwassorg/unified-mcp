const elements = {
  clients: document.querySelector("#clients"), empty: document.querySelector("#empty"), clientCount: document.querySelector("#clientCount"),
  pendingCount: document.querySelector("#pendingCount"), apiPort: document.querySelector("#apiPort"), bridgePort: document.querySelector("#bridgePort"),
  serverState: document.querySelector("#serverState"), livePill: document.querySelector(".live-pill"), lastUpdated: document.querySelector("#lastUpdated"), refresh: document.querySelector("#refresh")
};

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }
function time(value) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function age(value) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); return seconds < 2 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; }

async function refresh() {
  elements.refresh.disabled = true;
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    elements.clientCount.textContent = status.browsers.length;
    elements.pendingCount.textContent = status.pendingRequests;
    elements.apiPort.textContent = status.apiPort;
    elements.bridgePort.textContent = status.bridgePort;
    elements.serverState.textContent = "Server online";
    elements.livePill.classList.add("online");
    elements.clients.innerHTML = status.browsers.map((browser) => `<article class="client-card"><div class="client-top"><div><div class="client-name">${escapeHtml(browser.name)}</div><div class="client-id">${escapeHtml(browser.id)}</div></div><span class="badge">Connected</span></div><dl class="client-meta"><div><dt>Connected</dt><dd>${time(browser.connectedAt)}</dd></div><div><dt>Heartbeat</dt><dd>${age(browser.lastSeenAt)}</dd></div></dl></article>`).join("");
    elements.empty.hidden = status.browsers.length !== 0;
    elements.lastUpdated.textContent = `Updated ${time(new Date())}`;
  } catch {
    elements.serverState.textContent = "Server unavailable";
    elements.livePill.classList.remove("online");
    elements.lastUpdated.textContent = "Update failed";
  } finally { elements.refresh.disabled = false; }
}

elements.refresh.addEventListener("click", refresh);
refresh();
setInterval(refresh, 3000);
