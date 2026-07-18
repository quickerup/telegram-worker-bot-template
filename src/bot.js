const telegramApi = (token) => `https://api.telegram.org/bot${token}`;

export async function sendMessage(env, chatId, text, extra = {}) {
  const res = await fetch(`${telegramApi(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  if (!res.ok) {
    console.error('sendMessage failed', await res.text());
  }
  return res;
}

// ---------------------------------------------------------------------
// Add your own commands here. Each key is a /command (no slash),
// value is an async handler that receives (env, message).
// This is the main place you'll edit to build your bot.
// ---------------------------------------------------------------------
const commands = {
  start: async (env, msg) => {
    await sendMessage(
      env,
      msg.chat.id,
      "Hey! I'm alive and running on Cloudflare Workers. Send me anything and I'll echo it back. Try /help."
    );
  },
  help: async (env, msg) => {
    await sendMessage(
      env,
      msg.chat.id,
      'Commands:\n/start - greet\n/help - this message\n/trigger [repo] [workflow] [branch] - trigger a GitHub action\n\nAnything else you send gets echoed back.'
    );
  },
  trigger: async (env, msg) => {
    if (!env.GITHUB_PAT) {
      return sendMessage(env, msg.chat.id, "Please set GITHUB_PAT secret first.");
    }
    
    // Parse arguments: /trigger owner/repo workflow.yml branch
    const parts = msg.text.trim().split(/\s+/);
    const repo = parts[1] || "quickerup/telegram-worker-bot-template";
    const workflow = parts[2] || "deploy.yml";
    const branch = parts[3] || "main";

    await sendMessage(env, msg.chat.id, `Triggering \`${workflow}\` on \`${repo}\` (\`${branch}\`)...`);

    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'Cloudflare-Worker-Telegram-Bot',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: branch })
    });

    if (res.ok) {
      await sendMessage(env, msg.chat.id, `✅ Successfully triggered workflow!`);
    } else {
      const errorText = await res.text();
      await sendMessage(env, msg.chat.id, `❌ Failed to trigger (HTTP ${res.status}):\n${errorText}`);
    }
  },
};

export async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const text = msg.text.trim();

  if (text.startsWith('/')) {
    const command = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    const handler = commands[command];
    if (handler) {
      await handler(env, msg);
      return;
    }
  }

  // Default fallback: echo whatever was sent
  await sendMessage(env, msg.chat.id, `You said: ${text}`);
}
