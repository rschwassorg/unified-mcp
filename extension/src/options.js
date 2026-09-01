const fields = ["serverUrl", "browserId", "browserName", "psk"];
const values = await chrome.storage.local.get(fields);
document.querySelector("#serverUrl").value = values.serverUrl || "ws://127.0.0.1:18767";
document.querySelector("#browserId").value = values.browserId || crypto.randomUUID();
document.querySelector("#browserName").value = values.browserName || "My Chrome";
document.querySelector("#psk").value = values.psk || "";
document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set(Object.fromEntries(fields.map((key) => [key, document.querySelector(`#${key}`).value.trim()])));
  await chrome.runtime.sendMessage({ action: "reconnect" });
  document.querySelector("#saved").textContent = "Saved";
});
