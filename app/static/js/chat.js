let streamMode = true;
let tokenCount = 0;

function formatCodeBlocks(text) {
  if (!text) return "";
  return text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const language = (lang || "text").toUpperCase();
    const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div class="code-block"><small><i class="fas fa-code"></i> ${language}</small><pre>${escaped.trim()}</pre></div>`;
  });
}

function updateTokenCounter() {
  document.getElementById("token-counter").textContent = `Tokens: ${tokenCount}`;
}

function addMessage(content, isUser = false) {
  const chatBody = document.getElementById("chat-body");
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user-message" : "bot-message"}`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  messageDiv.innerHTML = `
    <div class="message-content">${formatCodeBlocks(content)}</div>
    <div class="message-time">${isUser ? "Você" : "Assistente"} • ${timeStr}</div>
  `;

  chatBody.appendChild(messageDiv);
  chatBody.scrollTop = chatBody.scrollHeight;

  if (!isUser) {
    tokenCount += content.split(/\s+/).filter(Boolean).length;
    updateTokenCounter();
  }
}

function setStreamMode(enable) {
  streamMode = enable;
  document.getElementById("btn-stream-on").classList.toggle("active", enable);
  document.getElementById("btn-stream-off").classList.toggle("active", !enable);
  document.getElementById("stream-mode").textContent = enable ? "Streaming" : "Instantâneo";
}

function resetSendButton() {
  document.getElementById("typing-indicator").style.display = "none";
  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = false;
  sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar';
}

async function checkApiStatus() {
  try {
    const r = await fetch("/health");
    const data = await r.json();
    const badge = document.getElementById("api-status");
    if (data.status === "healthy") {
      badge.className = "status-badge status-online";
      badge.innerHTML = '<i class="fas fa-circle"></i> API Online';
    } else {
      badge.className = "status-badge status-offline";
      badge.innerHTML = '<i class="fas fa-circle"></i> API Offline';
    }
  } catch {
    const badge = document.getElementById("api-status");
    badge.className = "status-badge status-offline";
    badge.innerHTML = '<i class="fas fa-circle"></i> API Offline';
  }
}

async function sendMessage() {
  const input = document.getElementById("prompt-input");
  const prompt = input.value.trim();
  const model = document.getElementById("model-select").value;

  if (!prompt) return;

  // Adiciona msg do usuário
  addMessage(prompt, true);
  input.value = "";

  // UI Loading
  document.getElementById("typing-indicator").style.display = "flex";
  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  // Decide qual método usar
  if (streamMode) {
    await streamResponse(prompt, model);
  } else {
    await generateResponse(prompt, model);
  }
}

// --- MODO SEM STREAM (Instantâneo) ---
async function generateResponse(prompt, model) {
  const chatBody = document.getElementById("chat-body");

  // Cria o balão do bot vazio (ou com um loader interno se preferir)
  const botMessageDiv = document.createElement("div");
  botMessageDiv.className = "message bot-message";
  const timeStr = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  
  botMessageDiv.innerHTML = `
    <div class="message-content" id="response-content">
        <span class="text-muted"><i class="fas fa-circle-notch fa-spin"></i> Gerando resposta completa...</span>
    </div>
    <div class="message-time">Assistente • ${timeStr}</div>
  `;
  chatBody.appendChild(botMessageDiv);
  chatBody.scrollTop = chatBody.scrollHeight;

  const contentEl = botMessageDiv.querySelector("#response-content");
  let fullResponse = "";

  try {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, prompt, chat_id: window.CHAT_ID })
    });

    const data = await r.json();

    if (!r.ok) {
        throw new Error(data.detail || "Erro desconhecido no servidor.");
    }

    // Sucesso: pega a resposta completa
    fullResponse = data.resposta;
    contentEl.innerHTML = formatCodeBlocks(fullResponse);
    chatBody.scrollTop = chatBody.scrollHeight;

  } catch (e) {
    contentEl.innerHTML = `<span class="text-danger"><i class="fas fa-exclamation-triangle"></i> Erro: ${e.message}</span>`;
  } finally {
    resetSendButton();
    if (fullResponse) {
        tokenCount += fullResponse.split(/\s+/).filter(Boolean).length;
        updateTokenCounter();
    }
  }
}

// --- MODO COM STREAM (SSE) ---
async function streamResponse(prompt, model) {
  const chatBody = document.getElementById("chat-body");

  const botMessageDiv = document.createElement("div");
  botMessageDiv.className = "message bot-message";
  const timeStr = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  botMessageDiv.innerHTML = `
    <div class="message-content" id="streaming-content"></div>
    <div class="message-time">Assistente • ${timeStr}</div>
  `;
  chatBody.appendChild(botMessageDiv);

  const contentEl = botMessageDiv.querySelector("#streaming-content");

  let fullResponse = "";
  let buffer = "";

  try {
    const r = await fetch("/api/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ model, prompt, chat_id: window.CHAT_ID })
    });

    if (!r.ok || !r.body) {
      throw new Error(`HTTP ${r.status}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = rawEvent.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          let evt;
          try { evt = JSON.parse(jsonStr); }
          catch { continue; }

          if (evt.type === "token") {
            fullResponse += evt.chunk || "";
            contentEl.innerHTML = formatCodeBlocks(fullResponse);
            chatBody.scrollTop = chatBody.scrollHeight;
          } else if (evt.type === "done") {
            // terminou
          } else if (evt.type === "error") {
            contentEl.innerHTML = `<span class="text-danger"><i class="fas fa-exclamation-triangle"></i> Erro: ${evt.error}</span>`;
          }
        }
      }
    }
  } catch (e) {
    contentEl.innerHTML = `<span class="text-danger"><i class="fas fa-exclamation-triangle"></i> Erro: ${e.message}</span>`;
  } finally {
    resetSendButton();
    tokenCount += fullResponse.split(/\s+/).filter(Boolean).length;
    updateTokenCounter();
  }
}

function clearChat() {
  const chatBody = document.getElementById("chat-body");
  chatBody.innerHTML = `
    <div class="message bot-message">
      <div class="message-content">Olá! Como posso ajudar você hoje?</div>
      <div class="message-time">Sistema</div>
    </div>
  `;
  tokenCount = 0;
  updateTokenCounter();
  resetSendButton();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("send-btn").addEventListener("click", sendMessage);
  document.getElementById("clear-btn").addEventListener("click", clearChat);

  document.getElementById("btn-stream-on").addEventListener("click", () => setStreamMode(true));
  document.getElementById("btn-stream-off").addEventListener("click", () => setStreamMode(false));

  document.getElementById("prompt-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  checkApiStatus();
  setInterval(checkApiStatus, 30000);
  document.getElementById("prompt-input").focus();
});