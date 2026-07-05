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

// ── Email templates ──────────────────────────────────────────────────────────
// Resend strips embedded <style>, so everything is inlined

function baseEmail({ title, subtitle, content, accentColor = '#1a1a1a' }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f5f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;padding:2rem 0;">
    <tr>
      <td align="center">
        <!-- Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;border:1px solid #eaeaea;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:1.75rem 2rem 0.75rem;text-align:center;">
              <div style="font-size:1.1rem;font-weight:700;color:${accentColor};letter-spacing:-0.02em;">
                Demo App
              </div>
            </td>
          </tr>
          ${title ? `
          <tr>
            <td style="padding:0 2rem 0.25rem;text-align:center;">
              <h2 style="margin:0;font-size:1.3rem;font-weight:600;color:#1a1a1a;">${title}</h2>
            </td>
          </tr>` : ''}
          ${subtitle ? `
          <tr>
            <td style="padding:0.25rem 2rem 1.25rem;text-align:center;">
              <p style="margin:0;font-size:0.875rem;color:#888;">${subtitle}</p>
            </td>
          </tr>` : ''}

          <!-- Divider -->
          <tr><td style="padding:0 2rem;"><div style="border-top:1px solid #eee;"></div></td></tr>

          <!-- Body -->
          <tr>
            <td style="padding:1.5rem 2rem;font-size:0.925rem;line-height:1.65;color:#333;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:1rem 2rem;background:#fafaf9;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;font-size:0.75rem;color:#aaa;">
                © ${year} Demo App &nbsp;·&nbsp; Sent via <span style="color:#888;">Resend</span>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// User-facing: AI acknowledgement reply
function userReplyEmail(aiReplyHtml) {
  return baseEmail({
    title: 'We received your message!',
    subtitle: 'Thanks for reaching out — here\'s a quick note back.',
    content: `
      <div style="background:#fafaf9;border-radius:8px;padding:1.25rem 1.5rem;border:1px solid #eee;">
        ${aiReplyHtml}
      </div>
      <p style="margin-top:1.25rem;color:#888;font-size:0.85rem;">
        If you need anything else, just reply to this email or use the chat widget on our site.
      </p>`,
  });
}

// Owner-facing: notification of a new form submission
function ownerNotificationEmail({ name, email, message, aiReplyHtml }) {
  return baseEmail({
    title: 'New contact form submission',
    subtitle: `${new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}`,
    accentColor: '#2563eb',
    content: `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:1rem;">
        <tr><td style="padding:0.35rem 0;font-weight:600;color:#1a1a1a;width:70px;">Name</td><td style="padding:0.35rem 0;color:#333;">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:0.35rem 0;font-weight:600;color:#1a1a1a;">Email</td><td style="padding:0.35rem 0;color:#2563eb;"><a href="mailto:${escapeHtml(email)}" style="color:#2563eb;">${escapeHtml(email)}</a></td></tr>
      </table>

      <div style="background:#fafaf9;border-radius:8px;padding:1.25rem 1.5rem;border:1px solid #eee;margin-bottom:1.25rem;">
        <p style="margin:0 0 0.5rem;font-weight:600;font-size:0.8rem;color:#888;text-transform:uppercase;letter-spacing:0.04em;">Message</p>
        <p style="margin:0;white-space:pre-wrap;color:#333;">${escapeHtml(message)}</p>
      </div>

      <div style="background:#f0f7ff;border-radius:8px;padding:1.25rem 1.5rem;border:1px solid #d6e8ff;">
        <p style="margin:0 0 0.5rem;font-weight:600;font-size:0.8rem;color:#2563eb;text-transform:uppercase;letter-spacing:0.04em;">AI auto-reply sent to user</p>
        <p style="margin:0;color:#1e40af;">${aiReplyHtml}</p>
      </div>`,
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
        html: ownerNotificationEmail({
          name, email, message,
          aiReplyHtml: '<em>AI reply skipped — daily token limit reached.</em>',
        }),
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
            content: `Write a brief, friendly email reply (3–4 sentences) to ${name} who sent this message: "${message}". Sign off as "<strong>The Team</strong>". Use simple HTML: <p> for paragraphs and <strong> for emphasis. Return the body content only — no wrapper tags like <html> or <body>.`,
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
      html: ownerNotificationEmail({ name, email, message, aiReplyHtml: aiReply }),
    });

    // 3. Send AI-generated acknowledgement to user
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'We received your message',
      html: userReplyEmail(aiReply),
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
