'use strict';

require('dotenv').config();

const express = require('express');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit: 5 form submissions per IP per 15 min
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Please try again later.' },
});

// ── SMTP transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── DeepSeek client (lightweight fetch, OpenAI-compatible) ────────────────────
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';

// ── AI cost control ──────────────────────────────────────────────────────────
// Per-IP daily message cap  |  Global daily token cap
const AI_DAILY_IP_LIMIT    = Number(process.env.AI_DAILY_IP_LIMIT)    || 30;   // msgs/day per IP
const AI_DAILY_TOKEN_LIMIT = Number(process.env.AI_DAILY_TOKEN_LIMIT) || 100_000; // tokens/day total

const usage = {
  ip: new Map(),       // ip → { count, day }
  globalTokens: 0,
  globalDay: new Date().toDateString(),
};

// Reset daily counters at midnight
function resetIfNewDay() {
  const today = new Date().toDateString();
  if (usage.globalDay !== today) {
    usage.ip.clear();
    usage.globalTokens = 0;
    usage.globalDay = today;
  }
}

function ipExceeded(ip) {
  resetIfNewDay();
  const today = new Date().toDateString();
  const rec = usage.ip.get(ip);
  if (!rec || rec.day !== today) return false;
  return rec.count >= AI_DAILY_IP_LIMIT;
}

function recordUsage(ip, tokens) {
  resetIfNewDay();
  const today = new Date().toDateString();
  const rec = usage.ip.get(ip);
  if (!rec || rec.day !== today) {
    usage.ip.set(ip, { count: 1, day: today });
  } else {
    rec.count++;
  }
  usage.globalTokens += tokens;
}

function globalExceeded() {
  resetIfNewDay();
  return usage.globalTokens >= AI_DAILY_TOKEN_LIMIT;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Contact form: validate → AI reply → send email
app.post('/api/contact', formLimiter, async (req, res) => {
  const { name, email, message } = req.body;

  // Basic validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 chars).' });
  }

  try {
    // Cost-control gate for contact form AI
    const ip = req.ip;
    if (ipExceeded(ip)) {
      return res.status(429).json({ error: 'Daily limit reached. Please try again tomorrow.' });
    }
    if (globalExceeded()) {
      // Still send the email, just skip the AI-generated reply
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: process.env.SMTP_TO,
        subject: `New contact form submission from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}\n\n---\n(AI reply skipped — daily token limit reached)`,
      });
      return res.json({ success: true, message: 'Message sent. We will get back to you shortly.' });
    }

    // 1. Generate AI acknowledgement via DeepSeek
    const dsResponse = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Write a brief, friendly acknowledgement email reply (3–4 sentences) to ${name} who sent this message: "${message}". Sign off as "The Team". Plain text only.`,
          },
        ],
      }),
    });

    const dsData = await dsResponse.json();
    const tokensUsed = dsData.usage?.total_tokens || 0;
    recordUsage(ip, tokensUsed);

    const aiReply = dsData.choices?.[0]?.message?.content?.trim()
      || 'Thank you for reaching out. We will get back to you shortly.';

    // 2. Send notification to site owner
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_TO,
      subject: `New contact form submission from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}\n\n---\nAI auto-reply sent to user:\n${aiReply}`,
    });

    // 3. Send AI-generated acknowledgement to user
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'We received your message',
      text: aiReply,
    });

    return res.json({ success: true, message: 'Message sent. Check your inbox for a confirmation.' });

  } catch (err) {
    console.error('Contact form error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Rate limit: 6 chat messages per IP per minute (generous for human, tight for bots)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { error: 'Too many messages. Please wait a moment.' },
});

// Chat endpoint: interactive DeepSeek conversation
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, history } = req.body;
  const ip = req.ip;

  if (!message || typeof message !== 'string' || message.length > 1000) {
    return res.status(400).json({ error: 'Message is required (max 1000 chars).' });
  }

  // ── Cost-control gates ──────────────────────────────────────────────────
  if (ipExceeded(ip)) {
    return res.status(429).json({ error: 'You have reached the daily message limit. Please try again tomorrow.' });
  }
  if (globalExceeded()) {
    return res.status(429).json({ error: 'AI chat is temporarily at capacity. Please check back later.' });
  }

  // Build messages array — keep last 10 turns for context
  const messages = [
    { role: 'system', content: 'You are a helpful assistant on a demo landing page. Keep replies concise (2-4 sentences). Be friendly and professional.' },
    ...(Array.isArray(history) ? history.slice(-10) : []),
    { role: 'user', content: message },
  ];

  try {
    const dsResponse = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: 300,
        messages,
      }),
    });

    const dsData = await dsResponse.json();

    if (!dsResponse.ok) {
      console.error('DeepSeek chat error:', dsData);
      return res.status(502).json({ error: 'AI service unavailable.' });
    }

    // Track token usage from DeepSeek's response
    const tokensUsed = dsData.usage?.total_tokens || 0;
    recordUsage(ip, tokensUsed);

    const reply = dsData.choices?.[0]?.message?.content?.trim()
      || 'Sorry, I could not process that.';

    return res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Health check (useful for deployment monitoring)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// AI usage stats (admin only — restrict in production with auth middleware)
app.get('/api/usage', (req, res) => {
  resetIfNewDay();
  const activeIPs = [];
  const today = new Date().toDateString();
  for (const [ip, rec] of usage.ip) {
    if (rec.day === today) activeIPs.push({ ip, count: rec.count });
  }
  res.json({
    day: today,
    activeIPs: activeIPs.length,
    globalTokensUsed: usage.globalTokens,
    globalTokenLimit: AI_DAILY_TOKEN_LIMIT,
    perIPMessageLimit: AI_DAILY_IP_LIMIT,
    percentUsed: ((usage.globalTokens / AI_DAILY_TOKEN_LIMIT) * 100).toFixed(1) + '%',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
