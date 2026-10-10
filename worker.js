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

      // Dutch → Azure TTS (native Flemish voice)
      if (body.lang === 'Dutch') {
        if (!env.AZURE_SPEECH_KEY) {
          return new Response(
            JSON.stringify({ error: 'AZURE_SPEECH_KEY not configured in Worker secrets.' }),
            { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        }
        const azureVoice = body.voice === 'male' ? 'nl-BE-ArnaudNeural' : 'nl-BE-DenaNeural';
        const safeText = body.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/[\r\n]+/g, ' ')
          .replace(/---+/g, '')
          .trim();
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="nl-BE"><voice name="${azureVoice}">${safeText}</voice></speak>`;
        let azureRes;
        try {
          azureRes = await fetch('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1', {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
              'Content-Type': 'application/ssml+xml',
              'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
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
          return new Response(
            JSON.stringify({ error: `Azure ${azureRes.status}: ${text}`, ssml }),
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
