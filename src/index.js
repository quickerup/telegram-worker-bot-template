import { handleUpdate } from './bot.js';

export default {
  async fetch(request, env, ctx) {
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
