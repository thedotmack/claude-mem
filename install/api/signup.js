// CMEM Online signup endpoint.
//
// The `npx claude-mem install` flow offers an optional email opt-in. The CLI
// POSTs the email (plus an optional note) here. This function runs on Vercel
// (the `install` project, install.cmem.ai) so the Resend API key stays a
// server-side secret and never ships inside the npx package.
//
// Configure via Vercel project env vars:
//   RESEND_API_KEY      (required) Resend API key — server-side only.
//   RESEND_AUDIENCE_ID  (optional) If set, each signup is added as a contact.
//   SIGNUP_NOTIFY_FROM  (optional) Verified Resend sender, e.g. "CMEM <hi@cmem.ai>".
//   SIGNUP_NOTIFY_TO    (optional) Where to email the signup + note (e.g. you).
//
// All Resend work is best-effort: if a step is not configured or fails, we log
// it and still return a non-fatal response. The CLI treats any non-2xx as a
// "we'll retry next time" and never breaks the install over it.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_API = 'https://api.resend.com';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readJsonBody(req) {
  // Vercel's Node runtime usually parses JSON into req.body, but fall back to
  // reading the raw stream for safety (e.g. missing content-type).
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function addContact(apiKey, audienceId, email) {
  const res = await fetch(`${RESEND_API}/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  // 409 (already a contact) is a success for our purposes.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Resend contacts ${res.status}: ${await res.text()}`);
  }
}

async function sendNotification(apiKey, { from, to, email, note, version, platform, source }) {
  const lines = [
    `<p><strong>Email:</strong> ${escapeHtml(email)}</p>`,
    note ? `<p><strong>Working on / how we can help:</strong><br/>${escapeHtml(note).replace(/\n/g, '<br/>')}</p>` : '',
    `<p style="color:#888;font-size:12px">version ${escapeHtml(version || 'unknown')} · ${escapeHtml(platform || 'unknown')} · via ${escapeHtml(source || 'unknown')}</p>`,
  ].filter(Boolean);
  const res = await fetch(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: email,
      subject: `CMEM Online signup: ${email}`,
      html: lines.join('\n'),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend emails ${res.status}: ${await res.text()}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const body = await readJsonBody(req);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 4000) : '';
  const version = typeof body?.version === 'string' ? body.version.slice(0, 64) : '';
  const platform = typeof body?.platform === 'string' ? body.platform.slice(0, 64) : '';
  const source = typeof body?.source === 'string' ? body.source.slice(0, 64) : '';

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Nothing wired up yet — accept the signup so the CLI doesn't keep
    // retrying, but make it visible in the logs that delivery was skipped.
    console.warn('[signup] RESEND_API_KEY not configured; accepted but not delivered:', email);
    return res.status(200).json({ ok: true, delivered: false });
  }

  const results = [];
  if (process.env.RESEND_AUDIENCE_ID) {
    try {
      await addContact(apiKey, process.env.RESEND_AUDIENCE_ID, email);
      results.push('contact');
    } catch (err) {
      console.error('[signup] addContact failed:', err);
    }
  }
  if (process.env.SIGNUP_NOTIFY_FROM && process.env.SIGNUP_NOTIFY_TO) {
    try {
      await sendNotification(apiKey, {
        from: process.env.SIGNUP_NOTIFY_FROM,
        to: process.env.SIGNUP_NOTIFY_TO,
        email,
        note,
        version,
        platform,
        source,
      });
      results.push('notify');
    } catch (err) {
      console.error('[signup] sendNotification failed:', err);
    }
  }

  if (results.length === 0) {
    // Configured but every delivery path failed — tell the CLI to retry later.
    return res.status(502).json({ ok: false, error: 'delivery_failed' });
  }
  return res.status(200).json({ ok: true, delivered: results });
}
