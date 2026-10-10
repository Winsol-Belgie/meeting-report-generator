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
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    // ── TTS route ──────────────────────────────────────────────────────
    if (url.pathname === '/tts') {
      if (!body.text) {
        return new Response('Missing text', { status: 400, headers: CORS });
      }
      if (!env.OPENAI_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'OPENAI_API_KEY not configured in Worker secrets.' }),
          { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      let ttsRes;
      try {
        ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1',
            input: body.text,
            voice: body.voice || 'nova',
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
