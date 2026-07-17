const status = document.querySelector("#status");
const details = document.querySelector("#details");
const reconnect = document.querySelector("#reconnect");

async function refresh() {
  const {
    connected = false,
    serverUrl = "ws://127.0.0.1:18765",
    lastError = null,
    updatedAt = null
  } = await chrome.storage.local.get(["connected", "serverUrl", "lastError", "updatedAt"]);
  status.textContent = connected ? "Connected" : "Offline";
  status.classList.toggle("connected", connected);
  status.classList.toggle("disconnected", !connected);
  details.textContent = connected
    ? `Connected to ${serverUrl}`
    : lastError || `Waiting for ${serverUrl}`;
  if (updatedAt) details.title = `Last update: ${updatedAt}`;
}

reconnect.addEventListener("click", async () => {
  reconnect.disabled = true;
  await chrome.runtime.sendMessage({ action: "reconnect" });
  setTimeout(() => {
    reconnect.disabled = false;
    refresh();
  }, 500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.connected) refresh();
});

refresh();
