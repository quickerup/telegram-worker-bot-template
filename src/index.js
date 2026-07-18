import { handleUpdate } from './bot.js';

// Simple in-memory ring buffer for logs (resets if the isolate restarts)
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function captureLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ` + args.map(a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
  }).join(' ');
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
}

console.log = (...args) => { captureLog('INFO', ...args); originalLog(...args); };
console.error = (...args) => { captureLog('ERROR', ...args); originalError(...args); };
console.warn = (...args) => { captureLog('WARN', ...args); originalWarn(...args); };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Provide a protected endpoint to read logs live
    if (url.pathname === '/logs' && request.method === 'GET') {
      const auth = request.headers.get('Authorization');
      // Protect it with your Telegram Bot Token
      if (auth !== `Bearer ${env.TELEGRAM_BOT_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(logBuffer.join('\n') + '\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // Simple health check for GET requests
    if (request.method !== 'POST') {
      return new Response('Bot is running.', { status: 200 });
    }

    // Verify the request genuinely came from Telegram.
    // Telegram sends this header back exactly as set during setWebhook.
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response('Bad Request', { status: 400 });
    }

    // Do the actual work after responding, so Telegram doesn't time out / retry.
    ctx.waitUntil(handleUpdate(update, env));

    return new Response('OK', { status: 200 });
  },
};
