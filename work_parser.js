#!/usr/bin/env node

/**
 * Telegram Work Parser
 * Monitors Telegram groups for:
 * 1. Client requests (people asking for automation / AI / bot help)
 * 2. Claude / AI updates and news
 *
 * Reading is delegated to an external Telegram user-client CLI, classification
 * is done by an LLM, and notifications are sent via the Telegram Bot API.
 *
 * All secrets and paths are supplied through the environment / config.example.json.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Optional AI helper (multi-provider fallback: Groq -> OpenAI -> OpenRouter) ---
// Point AI_HELPER_PATH at a module exporting `callAI(prompt, opts)`.
// If unavailable, the code falls back to the built-in Gemini call below.
let callAI = null;
if (process.env.AI_HELPER_PATH) {
  try {
    ({ callAI } = require(process.env.AI_HELPER_PATH));
  } catch (e) {
    console.error(`[WorkParser] Could not load AI_HELPER_PATH: ${e.message}`);
  }
}

// --- Config ---
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'state.json');
const LOG_PREFIX = '[WorkParser]';

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`${LOG_PREFIX} Failed to read config:`, e.message);
  process.exit(1);
}

// Optionally load additional environment variables from a .env file.
const envPath = process.env.ENV_FILE || path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// Secrets & endpoints come from the environment (never commit real values).
const GEMINI_KEY = process.env.GOOGLE_API_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TARGET_CHAT = process.env.TARGET_CHAT_ID || '';
const ADMIN_CHAT = process.env.ADMIN_CHAT_ID || '';
const TG_USER = process.env.TG_USER_PATH || config.tg_user_path;
const TG_USER_CWD = process.env.TG_USER_CWD || (TG_USER ? path.dirname(path.dirname(TG_USER)) : process.cwd());
const TG_USER_NODE_PATH = process.env.TG_USER_NODE_PATH || '';
const SCAN_INTERVAL = (config.scan_interval_minutes || 10) * 60 * 1000;
const MSGS_PER_SCAN = config.messages_per_scan || 30;
const MIN_MSG_LEN = config.min_message_length || 15;

if (!BOT_TOKEN || !TARGET_CHAT) {
  console.error(`${LOG_PREFIX} BOT_TOKEN and TARGET_CHAT_ID must be set (see .env.example)`);
  process.exit(1);
}

// --- State Management ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastMessageIds: {}, sentLeads: [], stats: { scans: 0, leads: 0, updates: 0 } };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Telegram Bot API ---
function sendTelegram(chatId, text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      chat_id: String(chatId),
      text: text.substring(0, 4000),
      parse_mode: parseMode,
      disable_web_page_preview: 'true'
    }).toString();

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            console.error(`${LOG_PREFIX} TG API error:`, result.description);
          }
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// --- Telegram user-client CLI wrapper ---
// Delegates channel/group reading to an external CLI (`<TG_USER> read <id> ...`).
function tgUserRead(groupId, limit, account = 1) {
  try {
    const cmd = `node ${TG_USER} read "${groupId}" --limit ${limit} --account ${account}`;
    const childEnv = { ...process.env };
    if (TG_USER_NODE_PATH) childEnv.NODE_PATH = TG_USER_NODE_PATH;
    const output = execSync(cmd, {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      cwd: TG_USER_CWD,
      env: childEnv
    });
    return output;
  } catch (e) {
    console.error(`${LOG_PREFIX} tg-user read error for ${groupId}:`, e.message?.substring(0, 200));
    return null;
  }
}

// --- Parse tg-user output into messages ---
function parseMessages(output) {
  if (!output) return [];

  const messages = [];
  const lines = output.split('\n');
  let currentMsg = null;

  for (const line of lines) {
    // Match: [DD.MM.YYYY, HH:MM] Sender (id:XXXX) @username [msg#YYYY]:
    // or:    [DD.MM.YYYY, HH:MM] Sender (id:XXXX)  [msg#YYYY]:  (no username)
    const headerMatch = line.match(/^\[(\d{2}\.\d{2}\.\d{4},?\s*\d{2}:\d{2})\]\s+(.+?)\s+\(id:(\?|\d+)\)\s+(@\S+)?\s*\[msg#(\d+)\]:/);
    if (headerMatch) {
      if (currentMsg) messages.push(currentMsg);
      currentMsg = {
        date: headerMatch[1],
        sender: headerMatch[2].trim(),
        senderId: headerMatch[3],
        username: headerMatch[4] || null,
        msgId: parseInt(headerMatch[5]),
        text: '',
        isReply: false
      };
      continue;
    }

    if (currentMsg) {
      if (line.trim().startsWith('[reply to msg#')) {
        currentMsg.isReply = true;
      } else if (line.startsWith('--- End of messages') || line.startsWith('=== Messages from')) {
        // skip
      } else if (line.match(/^\[media:/)) {
        currentMsg.text += ' [media]';
      } else {
        // Skip CLI debug logs (ANSI codes, [INFO], [WARN], [ERROR])
        const trimmed = line.trim();
        if (trimmed.match(/^\[?\x1b\[|\[INFO\]|\[WARN\]|\[ERROR\]|\[DEBUG\]|Disconnecting|connection closed|Connected as/)) continue;
        currentMsg.text += (currentMsg.text ? '\n' : '') + trimmed;
      }
    }
  }

  if (currentMsg) messages.push(currentMsg);

  // Filter out too-short messages
  return messages.filter(m => m.text.trim().length >= MIN_MSG_LEN);
}

// --- LLM Classification ---
async function classifyMessages(messages, groupName) {
  if (!messages.length) return [];

  // Batch classify up to 10 messages at a time
  const batches = [];
  for (let i = 0; i < messages.length; i += 10) {
    batches.push(messages.slice(i, i + 10));
  }

  const results = [];

  for (const batch of batches) {
    const msgList = batch.map((m, idx) =>
      `[${idx}] @${m.sender}: ${m.text.substring(0, 300)}`
    ).join('\n\n');

    const prompt = `Ты анализируешь сообщения из Telegram группы "${groupName}" (тема: AI, автоматизация, n8n, боты).

Классифицируй каждое сообщение в одну из категорий:
- "client_request" — человек ищет специалиста ИМЕННО по нашим услугам: боты, автоматизация, n8n, AI-интеграция, парсинг, скрейпинг, скрипты, CRM-интеграция, чат-боты. Признаки: "нужен бот", "ищу разработчика бота", "кто делает автоматизацию", "нужен парсер", "ищу n8n специалиста", "нужна интеграция с CRM", "кто может написать скрипт". ТОЛЬКО IT/автоматизация!
- "claude_update" — новости про Claude, Claude Code, Anthropic: обновления, новые фичи, баги, изменения API, новые модели. НЕ включай обычные обсуждения Claude.
- "self_improvement" — КОНКРЕТНЫЙ и ПРИМЕНИМЫЙ совет/трюк/настройка/инструмент для улучшения Claude Code, MCP серверов, n8n воркфлоу, автоматизации. Должен быть actionable: конкретная команда, конфиг, скрипт, промпт, MCP сервер, хук, плагин. НЕ общие рассуждения, а реально применимые штуки. Примеры: "добавьте в CLAUDE.md ...", "новый MCP сервер для X", "хук для auto-commit", "промпт для лучшего кодинга", "настройка settings.json для Y", конкретный bash alias, скрипт автоматизации.
- "ai_news" — ТОЛЬКО значимые новости: выход новой модели (GPT-5, Claude 5, Gemini 4), крупное обновление n8n/Make, закрытие/покупка сервиса. НЕ включать: рекламу услуг, советы по Яндекс.Директ, SEO-аудит, маркетинговые предложения — это всё "ignore".
- "ignore" — обычные обсуждения, вопросы по настройке (не заказ!), мемы, флуд, реклама, self-promo, ответы на вопросы других людей, технические обсуждения между коллегами. ЛЮБАЯ реклама своих услуг = ignore (даже если тема IT/автоматизация). Признаки рекламы: "предлагаю решение", "напишите в личку", "меня зовут ... я специалист по", "результаты клиентов", "бесплатный аудит", "подключаем", "обращайтесь", эмодзи-спам (📌✅🔐📍), хэштеги с предложением услуг.

ВАЖНО:
- Человек который СПРАШИВАЕТ как настроить что-то для себя — это НЕ client_request (это обычный вопрос в чате).
- client_request — это когда человек ЯВНО ищет кого-то кто СДЕЛАЕТ ЗА НЕГО работу, или спрашивает про стоимость услуг.
- ЧЕЛОВЕК КОТОРЫЙ ПРЕДЛАГАЕТ СВОИ УСЛУГИ (#помогу, "обращайтесь ко мне", "сделаю для вас", "места ограничены", "пишите мне", портфолио) — это ВСЕГДА "ignore". Это НЕ клиент, это конкурент.
- Хэштеги #помогу, #ищуработу, #фрилансер, #монтаж, #дизайн с предложением услуг = ВСЕГДА "ignore".
- client_request = ТОЛЬКО заказы на: ботов, автоматизацию, n8n, парсинг, скрипты, AI, CRM-интеграцию, чат-боты, голосовых ассистентов.
- НЕ client_request (всегда ignore): монтаж видео, дизайн, копирайтинг, SMM-менеджмент, маркетплейсы, бухгалтерия, юриспруденция, HR, фото/видеосъёмка, 3D, анимация, переводы, SEO-тексты, таргет, криптовалюта, обмен валют, USDT/тезер/крипта, трейдинг, инвестиции, недвижимость, логистика, грузоперевозки, строительство, ремонт, клининг, доставка, реклама в ТГ/Инсте, продвижение аккаунтов, накрутка, арбитраж трафика, дропшиппинг, товарный бизнес, обналичка, P2P обмен, ведение маркетплейсов (WB/Ozon/Яндекс.Маркет), менеджер WB/Ozon, карточки товаров, контент-менеджер, закупки, продажи, менеджер по продажам, бухгалтер, юрист, репетитор, няня — это НЕ наши услуги.
- self_improvement — ТОЛЬКО если совет КОНКРЕТНЫЙ и можно прямо взять и применить. Общие "claude крутой" — это ignore.
- В бизнес-чатах (предприниматели) 95% запросов НЕ связаны с IT — будь ОСОБЕННО строг. "Нужен специалист", "ищу подрядчика" без ЯВНОГО упоминания ботов/автоматизации/парсинга/AI = ignore.
- Если в сообщении нет ЯВНЫХ IT-ключевых слов (бот, автоматизация, парсинг, скрипт, CRM, API, интеграция, n8n, AI, нейросеть, чат-бот) — это НЕ client_request.
- Если сомневаешься — ставь "ignore".

Ответ СТРОГО в формате JSON массив:
[{"idx": 0, "category": "ignore"}, {"idx": 1, "category": "client_request"}, ...]

Сообщения:
${msgList}`;

    try {
      const response = await callLLM(prompt);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const item of parsed) {
          if (item.idx >= 0 && item.idx < batch.length) {
            results.push({
              ...batch[item.idx],
              category: item.category
            });
          }
        }
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} classification error:`, e.message?.substring(0, 200));
      // On error, skip this batch
    }

    // Rate limit between batches
    await sleep(2000);
  }

  return results;
}

async function callLLM(prompt) {
  // Primary: optional multi-provider helper (Groq -> OpenAI -> OpenRouter)
  if (callAI) {
    try {
      const result = await callAI(prompt, { temperature: 0.1, maxTokens: 1024 });
      if (result) return result;
      console.error(`${LOG_PREFIX} callAI returned empty result`);
    } catch (e) {
      console.error(`${LOG_PREFIX} callAI error (falling back to Gemini): ${e.message?.substring(0, 100)}`);
    }
  }

  // Fallback: direct Gemini call
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024
      }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.candidates && result.candidates[0]) {
            resolve(result.candidates[0].content.parts[0].text);
          } else {
            reject(new Error('No LLM response: ' + data.substring(0, 200)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// --- Extract username from sender ---
function extractContact(msg) {
  const sender = msg.sender || 'Unknown';
  const username = msg.username; // e.g. @username
  const senderId = msg.senderId;

  if (username) {
    return `${sender} (${username})`;
  }
  if (senderId && senderId !== '?') {
    return `${sender} (tg id: ${senderId})`;
  }
  return sender;
}

function contactLink(msg) {
  const username = msg.username;
  if (username) {
    // username already has @ prefix
    const clean = username.replace(/^@/, '');
    return `<a href="https://t.me/${clean}">${username}</a>`;
  }
  const senderId = msg.senderId;
  if (senderId && senderId !== '?') {
    return `<a href="tg://user?id=${senderId}">id:${senderId}</a>`;
  }
  return escapeHtml(msg.sender || 'Unknown');
}

// --- Format and send notifications ---
async function notifyClientRequest(msg, groupName) {
  const contact = extractContact(msg);
  const link = contactLink(msg);
  const text = `🔥 <b>Потенциальный клиент</b>\n` +
    `👤 ${link}\n` +
    `💬 Группа: ${escapeHtml(groupName)}\n` +
    `📝 Запрос: ${escapeHtml(msg.text.substring(0, 500))}\n` +
    `🕐 ${msg.date}`;

  await sendTelegram(TARGET_CHAT, text);
  console.log(`${LOG_PREFIX} 🔥 Lead sent: ${contact} from ${groupName}`);
}

async function notifyClaudeUpdate(msg, groupName) {
  const text = `🤖 <b>Claude/AI Update</b>\n` +
    `💬 Источник: ${escapeHtml(groupName)}\n` +
    `📝 ${escapeHtml(msg.text.substring(0, 800))}\n` +
    `🕐 ${msg.date}`;

  await sendTelegram(TARGET_CHAT, text);
  if (ADMIN_CHAT && ADMIN_CHAT !== TARGET_CHAT) {
    await sendTelegram(ADMIN_CHAT, text);
  }
  console.log(`${LOG_PREFIX} 🤖 Claude update sent from ${groupName}`);
}

async function notifyAiNews(msg, groupName) {
  const text = `📡 <b>AI News</b>\n` +
    `💬 Источник: ${escapeHtml(groupName)}\n` +
    `📝 ${escapeHtml(msg.text.substring(0, 800))}\n` +
    `🕐 ${msg.date}`;

  await sendTelegram(TARGET_CHAT, text);
  if (ADMIN_CHAT && ADMIN_CHAT !== TARGET_CHAT) {
    await sendTelegram(ADMIN_CHAT, text);
  }
  console.log(`${LOG_PREFIX} 📡 AI news sent from ${groupName}`);
}

async function handleSelfImprovement(msg, groupName) {
  // Step 1: Ask the LLM whether this tip is concrete and applicable.
  const evalPrompt = `Ты — AI агент который работает как Claude Code на сервере. У тебя есть:
- CLAUDE.md (инструкции)
- MCP серверы (n8n, задачи, память)
- settings.json (хуки, пермишены)
- Навыки/скилы в .claude/skills/
- Bash доступ

Вот совет из Telegram чата "${groupName}":
---
${msg.text.substring(0, 1500)}
---

Оцени:
1. Это КОНКРЕТНЫЙ и ПРИМЕНИМЫЙ совет? (не общие слова)
2. Может ли это улучшить рабочий процесс?
3. Безопасно ли это применить?

Ответ JSON:
{"apply": true/false, "reason": "почему", "action": "что конкретно сделать", "risk": "low/medium/high", "category": "claude_md|mcp|settings|script|hook|skill|other"}`;

  try {
    const evalResult = await callLLM(evalPrompt);
    const jsonMatch = evalResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`${LOG_PREFIX} Self-improvement eval failed to parse`);
      return;
    }

    const evaluation = JSON.parse(jsonMatch[0]);

    if (evaluation.apply && evaluation.risk !== 'high') {
      // Notify only — auto-apply is intentionally disabled (security).
      const notifText = `💡 <b>Полезный совет</b>\n` +
        `💬 Источник: ${escapeHtml(groupName)}\n` +
        `📝 ${escapeHtml(msg.text.substring(0, 400))}\n` +
        `🕐 ${msg.date}`;

      await sendTelegram(TARGET_CHAT, notifText);
      console.log(`${LOG_PREFIX} 💡 Useful tip sent (no auto-apply)`);
    } else {
      const skipText = `💡 <b>Improvement Tip (skipped)</b>\n` +
        `💬 Источник: ${escapeHtml(groupName)}\n` +
        `📝 ${escapeHtml(msg.text.substring(0, 500))}\n` +
        `❌ Причина: ${escapeHtml(evaluation.reason?.substring(0, 200) || 'not applicable')}\n` +
        `🕐 ${msg.date}`;

      await sendTelegram(TARGET_CHAT, skipText);
      if (ADMIN_CHAT && ADMIN_CHAT !== TARGET_CHAT) {
        await sendTelegram(ADMIN_CHAT, skipText);
      }
      console.log(`${LOG_PREFIX} 💡 Improvement skipped: ${evaluation.reason?.substring(0, 100)}`);
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Self-improvement handling error:`, e.message?.substring(0, 200));
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main scan loop ---
async function scanGroup(group, state) {
  const { id, name, account } = group;
  console.log(`${LOG_PREFIX} Scanning ${name} (${id})...`);

  const output = tgUserRead(id, MSGS_PER_SCAN, account || 1);
  if (!output) {
    console.log(`${LOG_PREFIX} No output from ${id}, skipping`);
    return;
  }

  const allMessages = parseMessages(output);
  if (!allMessages.length) {
    console.log(`${LOG_PREFIX} No messages parsed from ${id}`);
    return;
  }

  // Filter out already-seen messages
  const lastSeenId = state.lastMessageIds[id] || 0;
  const newMessages = allMessages.filter(m => m.msgId > lastSeenId);

  if (!newMessages.length) {
    console.log(`${LOG_PREFIX} No new messages in ${name} (last seen: ${lastSeenId})`);
    return;
  }

  console.log(`${LOG_PREFIX} ${newMessages.length} new messages in ${name}`);

  // Update last seen
  const maxMsgId = Math.max(...allMessages.map(m => m.msgId));
  state.lastMessageIds[id] = maxMsgId;

  // Classify with the LLM
  const classified = await classifyMessages(newMessages, name);

  let leadsCount = 0;
  let updatesCount = 0;

  for (const msg of classified) {
    if (msg.category === 'client_request') {
      // Deduplicate: check if we already sent this lead
      const leadKey = `${id}:${msg.msgId}`;
      if (!state.sentLeads.includes(leadKey)) {
        await notifyClientRequest(msg, name);
        state.sentLeads.push(leadKey);
        leadsCount++;
        await sleep(1500); // Rate limit sends
      }
    } else if (msg.category === 'claude_update') {
      await notifyClaudeUpdate(msg, name);
      updatesCount++;
      await sleep(1500);
    } else if (msg.category === 'self_improvement') {
      await handleSelfImprovement(msg, name);
      updatesCount++;
      await sleep(3000);
    } else if (msg.category === 'ai_news') {
      await notifyAiNews(msg, name);
      await sleep(1500);
    }
  }

  state.stats.leads += leadsCount;
  state.stats.updates += updatesCount;

  console.log(`${LOG_PREFIX} ${name}: ${leadsCount} leads, ${updatesCount} updates`);
}

async function runScan() {
  const state = loadState();
  state.stats.scans++;

  const enabledGroups = config.groups.filter(g => g.enabled);
  console.log(`${LOG_PREFIX} === Scan #${state.stats.scans} started (${enabledGroups.length} groups) ===`);

  for (let gi = 0; gi < enabledGroups.length; gi++) {
    const group = enabledGroups[gi];
    try {
      await scanGroup(group, state);
      // Rate limit: delay between groups to avoid TG account throttling
      if (gi < enabledGroups.length - 1) {
        await sleep(15000);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Error scanning ${group.name}:`, e.message);
    }
    // Wait between groups to avoid rate limits
    await sleep(5000);
  }

  // Trim sentLeads to keep state bounded
  if (state.sentLeads.length > 1000) {
    state.sentLeads = state.sentLeads.slice(-500);
  }

  state.lastScan = new Date().toISOString();
  saveState(state);
  console.log(`${LOG_PREFIX} === Scan complete. Total: ${state.stats.leads} leads, ${state.stats.updates} updates ===`);
}

// --- Health check server ---
const PORT = process.env.HEALTH_PORT || 3215;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      lastScan: state.lastScan,
      stats: state.stats,
      groups: config.groups.filter(g => g.enabled).map(g => g.name),
      uptime: process.uptime()
    }));
  } else if (req.url === '/scan') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Scan triggered');
    runScan().catch(e => console.error(`${LOG_PREFIX} Manual scan error:`, e));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`${LOG_PREFIX} Port ${PORT} in use, running without health check`);
  } else {
    console.error(`${LOG_PREFIX} Server error:`, err.message);
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`${LOG_PREFIX} Health check on http://127.0.0.1:${PORT}/health`);
});

// --- Main ---
async function main() {
  console.log(`${LOG_PREFIX} Starting Telegram Work Parser`);
  console.log(`${LOG_PREFIX} Groups: ${config.groups.filter(g => g.enabled).map(g => g.name).join(', ')}`);
  console.log(`${LOG_PREFIX} Scan interval: ${config.scan_interval_minutes} minutes`);
  console.log(`${LOG_PREFIX} Target: chat_id ${TARGET_CHAT}`);

  // First scan immediately
  await runScan();

  // Then schedule periodic scans
  setInterval(async () => {
    try {
      await runScan();
    } catch (e) {
      console.error(`${LOG_PREFIX} Scan loop error:`, e);
    }
  }, SCAN_INTERVAL);
}

main().catch(e => {
  console.error(`${LOG_PREFIX} Fatal error:`, e);
  process.exit(1);
});
