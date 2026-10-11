/**
 * Meeting Report Generator — Cloudflare Worker
 *
 * Secrets required (Cloudflare dashboard → Worker → Settings → Variables & Secrets):
 *   ANTHROPIC_API_KEY   — for report generation
 *   OPENAI_API_KEY      — for audio (TTS)
 *
 * Routes:
 *   POST /      → Anthropic Claude (report generation, streaming)
 *   POST /tts   → OpenAI TTS (text-to-speech, returns mp3)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
};

// ── Auth ───────────────────────────────────────────────────────────
const TOKEN_KEY_PREFIX = 'session:';
const SESSION_TTL_REMEMBER = 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_DEFAULT  = 60 * 60 * 12;       // 12 hours

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function getSession(request, env) {
  const token = request.headers.get('X-Auth-Token') || '';
  if (!token) return null;
  const raw = await env.MEETING_KV.get(TOKEN_KEY_PREFIX + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function handleLogin(body, env) {
  const username = (body.username || '').trim();
  const password  = body.password  || '';
  const remember  = !!body.remember;
  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'Username and password are required.' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  if (!env.PASSWORD_PEPPER) {
    return new Response(JSON.stringify({ error: 'PASSWORD_PEPPER not configured.' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const userRaw = await env.MEETING_KV.get('user:' + username);
  if (!userRaw) {
    return new Response(JSON.stringify({ error: 'Unknown username or wrong password.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  let user;
  try { user = JSON.parse(userRaw); } catch {
    return new Response(JSON.stringify({ error: 'Unknown username or wrong password.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const hash = await sha256Hex(password + env.PASSWORD_PEPPER);
  if (hash !== user.passwordHash) {
    return new Response(JSON.stringify({ error: 'Unknown username or wrong password.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const token = randomToken();
  const ttl   = remember ? SESSION_TTL_REMEMBER : SESSION_TTL_DEFAULT;
  await env.MEETING_KV.put(TOKEN_KEY_PREFIX + token, JSON.stringify({ username: user.username, role: user.role }), { expirationTtl: ttl });
  return new Response(JSON.stringify({ token, username: user.username, role: user.role }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function handleLogout(request, env) {
  const token = request.headers.get('X-Auth-Token') || '';
  if (token) await env.MEETING_KV.delete(TOKEN_KEY_PREFIX + token);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Auth routes (no session required) ─────────────────────────────
    if (body.mode === 'login')    return handleLogin(body, env);
    if (body.mode === 'logout')   return handleLogout(request, env);
    if (body.mode === 'auth_me') {
      const session = await getSession(request, env);
      return session
        ? new Response(JSON.stringify({ username: session.username, role: session.role }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'Not authenticated.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── All other routes require a valid session ───────────────────────
    const session = await getSession(request, env);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Not authenticated.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── TTS route ──────────────────────────────────────────────────────
    if (url.pathname === '/tts') {
      if (!body.text && !body.ssmlContent) {
        return new Response('Missing text or ssmlContent', { status: 400, headers: CORS });
      }

      // Dutch → Azure TTS (native Flemish voice)
      if (body.lang === 'Dutch') {
        if (!env.AZURE_SPEECH_KEY) {
          return new Response(
            JSON.stringify({ error: 'AZURE_SPEECH_KEY not configured in Worker secrets.' }),
            { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        }
        const azureVoice = body.voice === 'male' ? 'nl-BE-ArnaudNeural' : 'nl-BE-DenaNeural';
        // ssmlContent already has SSML tags; text is plain and needs escaping
        const voiceBody = body.ssmlContent
          ? body.ssmlContent
          : (body.text || '')
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
              .replace(/[\r\n]+/g, ' ').replace(/---+/g, '').trim();
        const ssml = `<speak version='1.0' xml:lang='nl-BE'><voice name='${azureVoice}'>${voiceBody}</voice></speak>`;
        let azureRes;
        try {
          azureRes = await fetch('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1', {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
              'Content-Type': 'application/ssml+xml; charset=utf-8',
              'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
              'User-Agent': 'WinsolMeetingReport/1.0',
            },
            body: ssml,
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: `Azure TTS failed: ${err.message}` }),
            { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        }
        if (!azureRes.ok) {
          const text = await azureRes.text();
          const hdrs = {};
          azureRes.headers.forEach((v, k) => { hdrs[k] = v; });
          return new Response(
            JSON.stringify({ error: `Azure ${azureRes.status}: ${text}`, headers: hdrs, ssml }),
            { status: azureRes.status, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        }
        return new Response(azureRes.body, { headers: { ...CORS, 'Content-Type': 'audio/mpeg' } });
      }

      // Other languages → OpenAI TTS
      if (!env.OPENAI_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'OPENAI_API_KEY not configured in Worker secrets.' }),
          { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
      const langInstructions = {
        'French':  'Speak in French. Use a natural, clear French accent. Read at a calm, professional pace.',
        'English': 'Speak in English. Use a clear, professional tone. Read at a calm pace.',
        'German':  'Speak in German. Use a natural, clear German accent. Read at a calm, professional pace.',
        'Spanish': 'Speak in Spanish. Use a natural, clear Spanish accent. Read at a calm, professional pace.',
        'Italian': 'Speak in Italian. Use a natural, clear Italian accent. Read at a calm, professional pace.',
      };
      const ttsInstruction = langInstructions[body.lang] || 'Speak clearly and professionally.';

      let ttsRes;
      try {
        ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini-tts',
            input: body.text,
            voice: body.voice || 'nova',
            instructions: ttsInstruction,
            response_format: 'mp3',
          }),
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: `TTS fetch failed: ${err.message}` }),
          { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      if (!ttsRes.ok) {
        const text = await ttsRes.text();
        return new Response(text, {
          status: ttsRes.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      return new Response(ttsRes.body, {
        headers: { ...CORS, 'Content-Type': 'audio/mpeg' },
      });
    }

    // ── Anthropic route (default) ──────────────────────────────────────
    if (!body.system || !body.messages) {
      return new Response('Missing system or messages', { status: 400, headers: CORS });
    }

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          stream: true,
          system: body.system,
          messages: body.messages,
        }),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Fetch failed: ${err.message}` }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    if (!claudeRes.ok) {
      const text = await claudeRes.text();
      return new Response(text, {
        status: claudeRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(claudeRes.body, {
      headers: {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  },
};
