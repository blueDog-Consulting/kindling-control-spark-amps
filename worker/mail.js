// Sends the sign-in email. Providers, in order of preference:
//
//   1. Cloudflare Email Service: a `send_email` binding named EMAIL in wrangler.jsonc.
//      The sender (MAIL_FROM) must be on a domain onboarded to Email Service.
//   2. Resend (https://resend.com): set the secret RESEND_API_KEY.
//   3. Development only: DEV_SHOW_LINKS = "1" logs the link and returns it to the caller
//      instead of sending anything. Never set this in production.
//
// The Email Service call shape follows Cloudflare's published examples; it hasn't been
// exercised against a live account from this repo yet (see docs/PRESETS.md).

import { HttpError } from './util.js';

export async function sendSignInEmail(env, to, link) {
  const from = parseAddress(env.MAIL_FROM || 'KindlingControl <presets@kindlingspark.app>');
  const subject = 'Your KindlingControl sign-in link';
  const text = [
    'Use this link to sign in to the KindlingControl presets hub:',
    '',
    link,
    '',
    'It works once and expires in 15 minutes.',
    "If you didn't ask for it, you can ignore this email.",
  ].join('\n');
  const html = `<p>Use this link to sign in to the KindlingControl presets hub:</p>
<p><a href="${escapeHtml(link)}">Sign in to KindlingControl</a></p>
<p>It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`;

  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    await env.EMAIL.send({ to: [{ email: to }], from, subject, text, html });
    return { provider: 'cloudflare' };
  }
  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: from.name ? `${from.name} <${from.email}>` : from.email, to: [to], subject, text, html }),
    });
    if (!res.ok) throw new Error(`Resend returned ${res.status}`);
    return { provider: 'resend' };
  }
  if (env.DEV_SHOW_LINKS === '1') {
    console.log(`[dev] sign-in link for ${to}: ${link}`);
    return { provider: 'dev', devLink: link };
  }
  throw new HttpError(503, "Signing in isn't available right now: email sending isn't set up.");
}

function parseAddress(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s);
  return m ? { email: m[2], name: m[1] || undefined } : { email: s.trim() };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
