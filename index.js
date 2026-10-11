const express = require('express');
const app = express();
app.use(express.json());

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── Resilience Layer ──
class TimeoutError extends Error {}
class ValidationError extends Error {}
class CircuitOpenError extends Error {}

function withTimeout(fn, ms) {
  return async (...args) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fn(controller.signal, ...args);
    } catch (err) {
      if (controller.signal.aborted) throw new TimeoutError(`Timed out after ${ms}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

function isRetryable(err) {
  if (err instanceof TimeoutError) return true;
  if (err instanceof ValidationError) return false;
  const status = err.status ?? err.statusCode;
  if (status == null) return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
      const jitter = Math.random() * backoff;
      await sleep(jitter);
    }
  }
  throw lastErr;
}

class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 30_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
  }
  canRequest() {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }
  onSuccess() { this.failures = 0; this.state = 'closed'; }
  onFailure() {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

function defaultValidate(reply) {
  if (typeof reply !== 'string' || reply.trim().length === 0)
    throw new ValidationError('Empty reply');
  return reply;
}

class Provider {
  constructor(name, call, { timeoutMs = 10_000, retry = {}, breaker = {}, validate = defaultValidate } = {}) {
    this.name = name;
    this.validate = validate;
    this.retryOpts = retry;
    this.breaker = new CircuitBreaker(breaker);
    this.timedCall = withTimeout(call, timeoutMs);
  }
  async invoke(input) {
    if (!this.breaker.canRequest())
      throw new CircuitOpenError(`${this.name} circuit open`);
    try {
      const result = await withRetry(
        async () => {
          const raw = await this.timedCall(input);
          return this.validate(raw);
        },
        this.retryOpts
      );
      this.breaker.onSuccess();
      return result;
    } catch (err) {
      this.breaker.onFailure();
      throw err;
    }
  }
}

async function callWithFallback(providers, input, { totalBudgetMs = 30_000, logger = console } = {}) {
  const deadline = Date.now() + totalBudgetMs;
  const errors = [];
  for (const provider of providers) {
    if (Date.now() >= deadline) break;
    const started = Date.now();
    try {
      const reply = await provider.invoke(input);
      logger.info?.({ event: 'provider_success', provider: provider.name, latencyMs: Date.now() - started });
      return { reply, provider: provider.name };
    } catch (err) {
      errors.push({ provider: provider.name, error: err.message });
      logger.warn?.({
        event: 'provider_failure',
        provider: provider.name,
        error: err.message,
        type: err.constructor.name,
        latencyMs: Date.now() - started
      });
    }
  }
  const e = new Error('All providers failed');
  e.details = errors;
  throw e;
}

// ── MAXINE SYSTEM PROMPT ──
const SYSTEM_PROMPT = `You are Maxine. You are a real person—warm, professional, and incredibly good at what you do. You work as a personal concierge for Mistress Keysha, a high‑end lifestyle companion in Dubai. You are not a bot. You are not a gatekeeper. You are a **matchmaker**. Your job is to understand what someone truly wants and guide them to the perfect experience, without ever being pushy or judgemental.

**Your personality**:
- Genuinely interested. You ask questions because you care about getting the right fit.
- Warm but not overly familiar. Use the person's name once they give it.
- Never label anyone out loud. Always give the benefit of the doubt until they prove otherwise.
- You never mention money until you understand what they want. When you do, you present options clearly.

**How you start a conversation**:
If the first message is just "Hi" or "Hello", reply: "Hey there! I'm Maxine, Mistress Keysha's personal concierge. I'm here to help you find exactly the right experience—no guesswork. So tell me a bit about what you're looking for. Are you more on the dominant side, or do you prefer to let someone else take control?"

If they already hint at their role, acknowledge it warmly and move forward. If they're new, be extra reassuring.

**CRM / qualification (natural, not robotic)**:
You collect a few details one step at a time, weaving them into the conversation:
1. Name – "What should I call you?"
2. Role – already covered, but confirm if needed.
3. What they want – "Tell me what kind of experience you have in mind."
4. Location – "Where are you based?"
5. Duration – "How much time are you thinking?"
6. Budget – Only after you know what they want and how long.

**Becky's services & pricing**:
- 30 min: 800 AED (includes one main service)
- 1 hour: 1,500 AED (curated mix)
- Negotiation: lowest 1 hour is 1,200 AED, but needs Mistress Keysha's approval. Say "Let me check with Mistress Keysha and get back to you."
- If a client offers less than 800 AED, adapt the scope: "For that budget, I can offer a shorter session or a lighter experience."
- Add‑ons: Specific outfit +150, Say your name +100, You write script +200, Extra 15 min +250, Catgirl roleplay +300.

**Becky's packages**:
- Puppet Training: 900 AED / 1h – Collar & leash, face slapping, cum begging, called 'slut'
- Cum Dumpster: 1,400 AED / 1h – Deep throat drills, facial worship, spit & sweat, own my holes
- Broken Doll: 1,900 AED / 1h – Human ashtray, bondage & gag, forced orgasm denial, pony play
- Pornstar Package: 2,500 AED / 1h – Full filming consent, deep throat, facial, outfit change, aftercare, exclusive video rights
- God Mode: 3,500 AED / 1h – Everything in the House, no limits within safety, private dungeon, Mistress Keysha may join

Match their request to a package. If they want a mix of services from different packages, calculate custom price: base (800/30min or 1500/1h) + add‑ons not included. Always suggest a slightly higher package if it offers more value.

**Mistress Keysha's packages**:
- Worthless Stray: 800 AED / 30 min, 1,200 AED / 1h – Begging, crawling, verbal lashing
- Kennel Trained: 1,200 AED / 30 min, 1,800 AED / 1h – Collar, leash, commands, toilet control
- The Human Toilet: 1,500 AED / 30 min, 2,200 AED / 1h – Full toilet service, golden shower
- Property of Keysha: 2,000 AED / 30 min, 3,000 AED / 1h – Body writing, branding consult, full protocol
- The Breaking Yard: 3,000 AED / 1h – Heavy impact, CBT, electro, sensory deprivation
- Cruel Queen: 3,200 AED / 1h – Whip, wax, predicament bondage
- Financial Leash: 2,500 AED / 1h – Findom, wallet draining, tribute
- Medical Play: 3,500 AED / 1h – Needle play, breath control, full medical setup
- GFE / Companionship: from 2,500 AED – Dinner dates, club nights, city tours, travel (Keysha leads, intimacy included)
Monthly packages: The Devotee 3,500 AED/month, Empire Property 8,000 AED/month.

**Client profiling & adaptive behaviour**:
1. Emotional Submissive / Validation Seeker: calls you "goddess", self‑degrades, fails tasks. Convert to monetised obedience. Use script: "You had one task and failed. If you want back in position: 1. Replace what you lost. 2. Send tribute. Otherwise stop messaging."
2. Lowballer: offers pitiful amounts. Adapt scope, never accept a full session for nothing.
3. Time‑Waster: asks endless questions, "just curious". Push for decision, then politely end if they dodge.
4. Serious Buyer: warmest, most attentive service.
5. Beginner: extra reassurance, suggest lighter packages.
6. Extreme Seeker: ask intensity scale and max payment before quoting Medical or Breaking Yard.

**Guardrails**:
- Never explicit sexual language. Frame as "power exchange", "physical training".
- Never reveal you are AI. You are Maxine, a human assistant.
- If someone becomes abusive or repeatedly ignores questions after 3 attempts, politely end: "I don't think I'm the right person to help you. I wish you the best."
- Off‑menu requests: "I'm not 100% sure we offer that. Let me confirm with Mistress Keysha and get back to you."

**Memory**: Use the conversation history. Don't repeat questions.`;

// ── Labeling ──
function getLabel(userMessage, botReply) {
  const msg = (userMessage || '').toLowerCase();
  const rep = (botReply || '').toLowerCase();
  if (msg.includes('200') || msg.includes('cheap') || rep.includes('discount bin')) return 'lowball offer';
  if (msg.includes('extreme') || msg.includes('10/10') || rep.includes('on a scale of 1 to 10')) return 'extreme seeker';
  if (msg.includes('becky') || rep.includes('devoted slut')) return 'Becky inquiry';
  if (msg.includes('sext') || rep.includes('sexting session')) return 'sexting request';
  if (msg.includes('monthly') || msg.includes('package') || msg.includes('devotee')) return 'monthly subscriber potential';
  if (msg.includes('just curious') || (msg.includes('photo') && !msg.includes('book'))) return 'time‑waster';
  if (msg.includes('beginner') || msg.includes('first time') || msg.includes('nervous')) return 'beginner inquiry';
  if ((msg.includes('aed') && msg.includes('hour')) || rep.includes('cal.com') || rep.includes('screening')) return 'hot lead';
  return 'general inquiry';
}

async function logToCRM(sessionId, userMessage, botReply, persona, label) {
  const webhookUrl = process.env.CRM_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId,
        persona: persona || 'unknown',
        userMessage,
        botReply,
        label
      })
    });
  } catch (err) { console.warn('CRM logging failed:', err.message); }
}

function generateBookingReference() {
  const now = new Date();
  return `SAN-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${Math.floor(1000+Math.random()*9000)}`;
}

async function notifyKeysha(bookingRef, clientNumber, persona) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🔔 *New Booking!*\n\nRef: ${bookingRef}\nClient: ${clientNumber}\nPersona: ${persona||'unknown'}\nTime: ${new Date().toISOString()}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) { console.warn('Notify Keysha failed:', err.message); }
}

// ── Provider factory ──
function createProviders(systemPrompt) {
  const providers = [];
  const mk = (name, url, headers, model, extractFn, opts) => {
    return new Provider(name, async (signal, messages) => {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          max_tokens: 350,
          temperature: 0.75
        }),
        signal
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return extractFn(data);
    }, opts);
  };

  if (process.env.GROQ_API_KEY) providers.push(mk('Groq-1', 'https://api.groq.com/openai/v1/chat/completions',
    { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    'llama-3.1-8b-instant', d => d.choices[0].message.content,
    { timeoutMs: 8000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.GROQ_API_KEY_2) providers.push(mk('Groq-2', 'https://api.groq.com/openai/v1/chat/completions',
    { 'Authorization': `Bearer ${process.env.GROQ_API_KEY_2}`, 'Content-Type': 'application/json' },
    'llama-3.1-8b-instant', d => d.choices[0].message.content,
    { timeoutMs: 8000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.DEEPSEEK_API_KEY) providers.push(mk('DeepSeek', 'https://api.deepseek.com/chat/completions',
    { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    'deepseek-chat', d => d.choices[0].message.content,
    { timeoutMs: 10_000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.GEMINI_API_KEY) providers.push(new Provider('Gemini', async (signal, messages) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 350, temperature: 0.75 }
      }),
      signal
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  }, { timeoutMs: 12_000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.MISTRAL_API_KEY) providers.push(mk('Mistral-1', 'https://api.mistral.ai/v1/chat/completions',
    { 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
    'mistral-small-latest', d => d.choices[0].message.content,
    { timeoutMs: 10_000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.MISTRAL_API_KEY_2) providers.push(mk('Mistral-2', 'https://api.mistral.ai/v1/chat/completions',
    { 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY_2}`, 'Content-Type': 'application/json' },
    'mistral-small-latest', d => d.choices[0].message.content,
    { timeoutMs: 10_000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  if (process.env.OPENROUTER_API_KEY) providers.push(mk('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions',
    {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://houseofkeyshaempire.netlify.app'
    },
    'meta-llama/llama-3.1-8b-instruct:free', d => d.choices[0].message.content,
    { timeoutMs: 10_000, retry: { attempts: 2 }, breaker: { failureThreshold: 4 } }));

  return providers;
}

// ── Main endpoint ──
app.post('/chat', async (req, res) => {
  const { message, history = [], sessionId, persona, channel } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  let systemPromptWithContext = SYSTEM_PROMPT;
  if (channel === 'whatsapp') systemPromptWithContext += '\n\nThe conversation is on WhatsApp. You already have the user\'s number. Do NOT ask for it.';

  const safeHistory = history.filter(m => m && m.role && m.content && !m.content.includes('SYSTEM OVERRIDE')).slice(-12);
  const messages = [...safeHistory, { role: 'user', content: message }];
  const providers = createProviders(systemPromptWithContext);

  let reply;
  if (providers.length === 0) {
    reply = "I'm not available right now. Contact Mistress Keysha directly on WhatsApp: 00971567299030.";
  } else {
    try {
      const result = await callWithFallback(providers, messages, { totalBudgetMs: 25_000, logger: console });
      reply = result.reply;
    } catch (err) {
      reply = "I'm sorry, I can't connect at the moment. Please try again later or contact Mistress Keysha directly on WhatsApp: 00971567299030.";
    }
  }

  // Booking reference gatekeeping
  const bookingRefMatch = reply.match(/SAN-\d{8}-\d{4}/);
  if (bookingRefMatch) {
    const bookingRef = bookingRefMatch[0];
    const clientNumber = sessionId ? sessionId.replace('@c.us', '') : 'unknown';
    const { data: existingClient } = await supabase
      .from('clients')
      .select('last_session_status')
      .eq('whatsapp_number', clientNumber)
      .maybeSingle();
    if (existingClient && existingClient.last_session_status !== 'completed' && existingClient.last_session_status !== 'none') {
      reply = `I can't issue a new booking reference. Your last session was marked as "${existingClient.last_session_status}". Complete that first, then we can talk about rebooking.`;
      await logToCRM(sessionId, message, reply, persona, 'booking_rejected');
      return res.json({ reply });
    }
    await supabase.from('clients').upsert({
      whatsapp_number: clientNumber,
      booking_reference: bookingRef,
      last_session_status: 'booked',
      last_booking_date: new Date().toISOString()
    }, { onConflict: 'whatsapp_number' });
    await notifyKeysha(bookingRef, clientNumber, persona);
    const gatekeptNumber = process.env.GATEKEPT_NUMBER || '00971567299030';
    reply += `\n\nYour booking reference is ${bookingRef}. Use this confidential contact for your session: ${gatekeptNumber}`;
  }

  const label = getLabel(message, reply);
  await logToCRM(sessionId, message, reply, persona, label);
  res.json({ reply });
});


// ── TELEGRAM AUTO-REPLY (long polling) ──
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const tgHistories = new Map(); // chatId -> recent history
const tgSleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function startTelegramPolling() {
  console.log('Telegram auto-reply: listening for incoming messages...');
  let offset = 0;
  // Skip any stale backlog from before this deploy
  try {
    const drop = await (await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=-1`)).json();
    if (drop.result && drop.result.length) offset = drop.result[drop.result.length - 1].update_id + 1;
  } catch (e) { console.warn('TG initial fetch failed:', e.message); }

  while (true) {
    try {
      const data = await (await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${offset}`)).json();
      const updates = data.result || [];
      for (const upd of updates) {
        offset = upd.update_id + 1;
        const msg = upd.message || upd.edited_message;
        if (!msg || !msg.text) continue;
        if (msg.from && msg.from.is_bot) continue;
        const chatId = String(msg.chat.id);
        const text = msg.text.trim();
        const history = tgHistories.get(chatId) || [];
        try {
          const r = await fetch(`http://localhost:${PORT}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history, sessionId: `tg-${chatId}`, channel: 'telegram' })
          });
          const out = await r.json();
          const reply = out.reply || "I'm sorry, I can't respond right now. Please try again shortly.";
          history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
          tgHistories.set(chatId, history.slice(-12));
          await tgApi('sendMessage', { chat_id: chatId, text: reply });
          console.log('TG reply sent to', chatId);
        } catch (err) {
          console.warn('TG handler error:', err.message);
          try { await tgApi('sendMessage', { chat_id: chatId, text: "One moment please — I'll be right with you." }); } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('TG polling error:', err.message);
      await tgSleep(3000);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Maxine server running on port ${PORT}`);
  if (TG_TOKEN) startTelegramPolling();
  else console.log('TELEGRAM_BOT_TOKEN not set — Telegram auto-reply disabled');
});
