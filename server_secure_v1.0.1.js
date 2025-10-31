/**
 * ==========================================================
 *  server_secure_v1.0.1.js
 *  ✅ Render用「Kintone履歴保持 × サーバ揮発」構成
 *  ✅ OpenAI通信後はセッション即削除（痕跡ゼロ）
 * ==========================================================
 */

import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import cors from "cors";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// ----------------------------------------------------------
// Kintone ヘルパー
// ----------------------------------------------------------
async function kGetRecords(appId, token, query) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  const data = await res.json();
  return data.records || [];
}

async function kUpdateRecord(appId, token, id, recordObj) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/record.json`;
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Cybozu-API-Token": token },
    body: JSON.stringify({ app: appId, id, record: recordObj })
  });
}

// ----------------------------------------------------------
// OpenAI初期化
// ----------------------------------------------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log("✅ OpenAI SDK ready (Ephemeral mode)");

// ----------------------------------------------------------
// Ephemeral session（サーバ一時保持用メモリ）
// ----------------------------------------------------------
const sessionStore = new Map();
const SESSION_TTL = 1000 * 60 * 30; // 30分
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of sessionStore.entries()) {
    if (now - data.timestamp > SESSION_TTL) sessionStore.delete(id);
  }
}, 60000);

// ----------------------------------------------------------
// /assist/thread-chat
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  const { chatRecordId, message, model = "gpt-5" } = req.body;
  const sessionId = uuidv4();

  try {
    if (!chatRecordId || !message) {
      return res.status(400).json({ error: "Missing chatRecordId or message" });
    }

    // === 一時セッション登録（メモリのみ） ===
    sessionStore.set(sessionId, { message, model, timestamp: Date.now() });

    const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
    const CHAT_TOKEN = process.env.KINTONE_CHAT_TOKEN;

    // === KintoneからAssistant設定を取得 ===
    const chats = await kGetRecords(CHAT_APP_ID, CHAT_TOKEN, `$id = ${chatRecordId}`);
    if (chats.length === 0) throw new Error("Chat record not found");
    const chat = chats[0];

    const assistantConfig =
      chat.assistant_config?.value || "あなたは誠実で丁寧な日本語アシスタントです。";

    // === OpenAI推論（Ephemeral実行） ===
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: assistantConfig },
        { role: "user", content: message }
      ],
      temperature: 0.7
    });

    const reply = completion.choices?.[0]?.message?.content || "（返答なし）";
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    // === ✅ Kintoneにチャット履歴を追加 ===
    const newRow = {
      value: {
        user_message: { value: message },
        ai_reply: { value: htmlReply }
      }
    };
    const newLog = (chat.chat_log?.value || []).concat(newRow);
    await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, { chat_log: { value: newLog } });

    res.json({ reply: htmlReply });
  } catch (err) {
    console.error("❌ /assist/thread-chat Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // ✅ サーバセッション削除（Render上に痕跡を残さない）
    sessionStore.delete(sessionId);
  }
});

// ----------------------------------------------------------
// Health check
// ----------------------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ Render Secure Server running (Kintone履歴保持 × サーバ揮発)");
});

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
