/**
 * ==========================================================
 *  server_secure_v1.0.2.js
 *  ✅ Render用 Secure版：Kintone履歴保持 × サーバ揮発
 *  ✅ フロント(messages配列)仕様に完全対応
 *  ✅ OpenAI通信後はメモリ即削除（痕跡ゼロ）
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
app.use(
  cors({
    origin: "*",
    methods: ["POST", "GET"],
    allowedHeaders: ["Content-Type"],
  })
);

// ----------------------------------------------------------
// Kintone ヘルパー（履歴保存用）
// ----------------------------------------------------------
async function kGetRecords(appId, token, query) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  const data = await res.json();
  return data.records || [];
}

async function kUpdateRecord(appId, token, id, recordObj) {
  const url = `https://${process.env.KINTONE_DOMAIN}/k/v1/record.json`;
  await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Cybozu-API-Token": token,
    },
    body: JSON.stringify({ app: appId, id, record: recordObj }),
  });
}

// ----------------------------------------------------------
// OpenAI初期化
// ----------------------------------------------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log("✅ OpenAI SDK ready (Secure v1.0.2)");

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
// /assist/thread-chat (messages配列対応版)
// ----------------------------------------------------------
app.post("/assist/thread-chat", async (req, res) => {
  const { messages, model = "gpt-4o" } = req.body;
  const sessionId = uuidv4();

  try {
    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // === 一時セッション登録（メモリのみ） ===
    sessionStore.set(sessionId, { messages, model, timestamp: Date.now() });

    // === OpenAI推論（Ephemeral実行） ===
    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.7,
    });

    const reply = completion.choices?.[0]?.message?.content || "（返答なし）";
    const htmlReply = DOMPurify.sanitize(marked.parse(reply));

    // === ✅ Kintoneへの履歴保存 ===
    try {
      const CHAT_APP_ID = process.env.KINTONE_CHAT_APP_ID;
      const CHAT_TOKEN = process.env.KINTONE_CHAT_TOKEN;

      // messagesの最後のuserメッセージのみを履歴化
      const userMsg = messages[messages.length - 1]?.content || "";

      // 直近レコードを取得（最新1件）
      const chats = await kGetRecords(
        CHAT_APP_ID,
        CHAT_TOKEN,
        "order by $id desc limit 1"
      );
      if (chats.length > 0) {
        const chat = chats[0];
        const newRow = {
          value: {
            user_message: { value: userMsg },
            ai_reply: { value: htmlReply },
          },
        };
        const newLog = (chat.chat_log?.value || []).concat(newRow);
        await kUpdateRecord(CHAT_APP_ID, CHAT_TOKEN, chat.$id.value, {
          chat_log: { value: newLog },
        });
      }
    } catch (e) {
      console.warn("⚠️ Kintone履歴保存エラー:", e.message);
    }

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
  res.send("✅ Secure Server v1.0.2 running (messages仕様対応・履歴保持・揮発メモリ)");
});

// ----------------------------------------------------------
// サーバ起動
// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Secure Server v1.0.2 running on port ${PORT}`)
);
