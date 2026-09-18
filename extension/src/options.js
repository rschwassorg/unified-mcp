const fields = ["serverUrl", "browserId", "browserName"];
const values = await chrome.storage.local.get(fields);

document.querySelector("#serverUrl").value = values.serverUrl || "wss://unified-mcp.pentestsystem.com/bridge";
document.querySelector("#browserId").value = values.browserId || crypto.randomUUID();
document.querySelector("#browserName").value = values.browserName || "My Chrome";

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set(Object.fromEntries(
    fields.map((key) => [key, document.querySelector(`#${key}`).value.trim()])
  ));
  await chrome.runtime.sendMessage({ action: "reconnect" });
  document.querySelector("#saved").textContent = "Saved";
});

document.querySelector("#cloudflareLogin").addEventListener("click", async () => {
  const websocketUrl = document.querySelector("#serverUrl").value.trim();
  let loginUrl;
  try {
    const parsed = new URL(websocketUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.hash = "";
    loginUrl = parsed.toString();
  } catch {
    document.querySelector("#saved").textContent = "Enter a valid WebSocket URL first";
    return;
  }

  await chrome.tabs.create({ url: loginUrl, active: true });
  document.querySelector("#saved").textContent = "Complete Cloudflare Access sign-in, then reconnect";
});
