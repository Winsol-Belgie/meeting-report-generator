/**
 * Meeting Report Generator — Cloudflare Worker
 *
 * Setup:
 *   1. Deploy this file to Cloudflare Workers
 *   2. Add secret:  wrangler secret put ANTHROPIC_API_KEY
 *   3. Copy the worker URL into index.html (WORKER_URL constant)
 *
 * The worker acts as a secure proxy: the API key never leaves Cloudflare.
 * It forwards requests to the Anthropic API and streams the response back.
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

    // Validate required fields
    if (!body.system || !body.messages) {
      return new Response('Missing system or messages', { status: 400, headers: CORS });
    }

    // Forward to Anthropic with streaming
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

    // Stream response back
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
