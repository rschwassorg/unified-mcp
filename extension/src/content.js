chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

async function handleMessage(message) {
  switch (message?.action) {
    case "page.text":
      return getPageText();
    case "page.click":
      return clickSelector(message.selector);
    case "page.type":
      return typeIntoSelector(message.selector, message.text, message.clear);
    default:
      throw new Error(`Unknown content action: ${message?.action}`);
  }
}

function getPageText() {
  const text = document.body?.innerText || "";
  return {
    title: document.title,
    url: location.href,
    text: text.replace(/\n{3,}/g, "\n\n").trim()
  };
}

function clickSelector(selector) {
  const element = findElement(selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return { clicked: true, selector };
}

function typeIntoSelector(selector, text, clear = true) {
  const element = findElement(selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();

  if (!("value" in element)) {
    throw new Error(`Element is not typeable: ${selector}`);
  }

  if (clear) element.value = "";
  element.value += text ?? "";
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text ?? "" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return { typed: true, selector, length: String(text ?? "").length };
}

function findElement(selector) {
  if (!selector) throw new Error("selector is required");
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}
