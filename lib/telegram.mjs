/** Minimal Telegram Bot API client (no SDK, same style as the rest of the repo). */

export function createTelegram(token) {
  const api = `https://api.telegram.org/bot${token}`;
  const fileApi = `https://api.telegram.org/file/bot${token}`;

  async function call(method, body) {
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`${method} failed: ${data.description || res.status}`);
    return data.result;
  }

  return {
    call,
    sendMessage: (chatId, text, extra = {}) =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),

    /** Upload a small text file (used for the durable state backup). */
    async sendDocument(chatId, filename, content, caption) {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("disable_notification", "true");
      if (caption) form.append("caption", caption);
      form.append("document", new Blob([content], { type: "application/json" }), filename);
      const res = await fetch(`${api}/sendDocument`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(`sendDocument failed: ${data.description || res.status}`);
      return data.result;
    },

    async downloadFile(fileId) {
      const file = await call("getFile", { file_id: fileId });
      const res = await fetch(`${fileApi}/${file.file_path}`);
      if (!res.ok) throw new Error(`file download failed: ${res.status}`);
      return res.text();
    },
  };
}

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
