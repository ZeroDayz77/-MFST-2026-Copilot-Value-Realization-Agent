// Provider-abstracted email sender with a HARD SAFETY GATE.
//
// Nothing is ever delivered to a real inbox unless BOTH are true:
//   1. MAIL_SEND_ENABLED=true   (the explicit on/off gate)
//   2. a real provider (smtp|graph) is fully configured
// Otherwise this runs in "mock" mode: it records the send (status 'sent', mock:true)
// without anything leaving the box. config.mail.provider already resolves to 'mock'
// unless the gate is on AND a provider is configured, but we re-check here so the
// gate can never be bypassed by calling this module directly.

import config from '../config.js';

let nodemailerMod; // lazy-loaded only when SMTP is actually used

function newId() {
  return `out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Mock "send": no network, never delivers. The visible proof of the loop.
function mockSend({ to, subject }) {
  console.log(`[mail:mock] (not delivered) to=${to} subject="${subject}"`);
  return { status: 'sent', provider: 'mock', mock: true, id: newId() };
}

async function smtpSend({ to, subject, body, from }) {
  if (!nodemailerMod) {
    nodemailerMod = (await import('nodemailer')).default;
  }
  const { host, port, user, pass, secure } = config.mail.smtp;
  const transport = nodemailerMod.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  const info = await transport.sendMail({
    from: from || config.mail.fromAddress,
    to,
    subject,
    text: body,
  });
  return { status: 'sent', provider: 'smtp', mock: false, id: info.messageId || newId() };
}

// Microsoft Graph application-permission send (client credentials → /sendMail).
async function graphSend({ to, subject, body }) {
  const { tenantId, clientId, clientSecret, sender } = config.mail.graph;
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(`Graph token error: ${tokenJson.error_description || tokenRes.status}`);
  }
  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    },
  );
  if (!sendRes.ok) {
    const txt = await sendRes.text();
    throw new Error(`Graph sendMail ${sendRes.status}: ${txt.slice(0, 300)}`);
  }
  return { status: 'sent', provider: 'graph', mock: false, id: newId() };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('mail send timed out')), ms)),
  ]);
}

export const mail = {
  // True only when a real provider is configured AND the gate is on.
  get live() {
    return config.mail.live;
  },

  // Send an email. Always resolves to a result object (never throws): on failure
  // returns { status:'failed', error }. Honors the hard gate — falls back to mock.
  async send({ to, subject, body, from } = {}) {
    if (!to) return { status: 'failed', provider: config.mail.provider, mock: !this.live, error: 'no recipient address' };

    // The gate: anything other than a live+configured provider is a mock send.
    if (config.mail.provider === 'mock') {
      return mockSend({ to, subject });
    }

    try {
      if (config.mail.provider === 'smtp') {
        return await withTimeout(smtpSend({ to, subject, body, from }), config.mail.timeoutMs);
      }
      if (config.mail.provider === 'graph') {
        return await withTimeout(graphSend({ to, subject, body }), config.mail.timeoutMs);
      }
      return mockSend({ to, subject });
    } catch (err) {
      console.error('[mail] send failed:', err.message);
      return { status: 'failed', provider: config.mail.provider, mock: false, error: err.message };
    }
  },

  status() {
    return {
      provider: config.mail.provider, // effective (mock unless live)
      requested_provider: config.mail.requestedProvider,
      send_enabled: config.mail.sendEnabled, // the gate
      provider_configured: config.mail.providerConfigured,
      live: config.mail.live, // gate ON and provider configured
      from: config.mail.fromAddress,
      default_autonomy: config.mail.defaultAutonomy,
    };
  },
};

export default mail;
