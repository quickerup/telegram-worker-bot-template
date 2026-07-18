import _sodium from 'libsodium-wrappers';

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
      'Commands:\n/start - greet\n/help - this message\n/trigger [repo] [workflow] [branch] - trigger a GitHub action\n/makeworkflow [repo] [description] - use AI to design and commit a new workflow\n\nAnything else you send gets echoed back.'
    );
  },
  trigger: async (env, msg) => {
    if (!env.GHPAT) {
      return sendMessage(env, msg.chat.id, "Please set GHPAT secret first.");
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
        'Authorization': `Bearer ${env.GHPAT}`,
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
  makeworkflow: async (env, msg) => {
    if (!env.GHPAT) return sendMessage(env, msg.chat.id, "Please set GHPAT secret first.");

    const parts = msg.text.trim().split(/\s+/);
    if (parts.length < 3) {
      return sendMessage(env, msg.chat.id, "Usage: /makeworkflow [owner/repo] [description of the workflow]");
    }
    const repo = parts[1];
    const prompt = parts.slice(2).join(" ");

    await sendMessage(env, msg.chat.id, `🤖 Asking AI to design workflow for \`${repo}\`...`);

    try {
      const aiRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.AI_CF_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messages: [
              {
                role: 'system',
                content: "You are an expert GitHub Actions engineer. Return ONLY a raw, valid YAML workflow for GitHub Actions based on the user's request. Do not use markdown formatting like ```yaml, just output the raw text. Do not add any conversational text."
              },
              { role: 'user', content: prompt }
            ]
          })
        }
      );

      if (!aiRes.ok) {
        return sendMessage(env, msg.chat.id, `❌ AI request failed (${aiRes.status}): ${await aiRes.text()}`);
      }

      const aiData = await aiRes.json();
      let yaml = (aiData.result?.response || '').trim();
      
      // Cleanup markdown if the AI still included it
      if (yaml.startsWith("```")) {
        yaml = yaml.replace(/^```[a-z]*\n?/, "").replace(/\n```$/, "");
      }

      const filename = `bot_generated_${Date.now()}.yml`;
      const path = `.github/workflows/${filename}`;

      await sendMessage(env, msg.chat.id, `✍️ Generated workflow. Committing to \`${path}\` on \`${repo}\`...`);

      // Safe base64 encoding for UTF-8 string
      const contentBase64 = btoa(unescape(encodeURIComponent(yaml)));

      const ghRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${env.GHPAT}`,
          "User-Agent": "Cloudflare-Worker-Telegram-Bot",
          "Content-Type": "application/json",
          "Accept": "application/vnd.github.v3+json"
        },
        body: JSON.stringify({
          message: `Add workflow generated by Telegram Bot (AI)`,
          content: contentBase64
        })
      });

      if (!ghRes.ok) {
        return sendMessage(env, msg.chat.id, `❌ Failed to commit to GitHub: ${await ghRes.text()}`);
      }

      await sendMessage(env, msg.chat.id, `✅ Workflow \`${filename}\` committed! Seeding Cloudflare secrets into \`${repo}\`...`);

      if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
        return sendMessage(env, msg.chat.id, `⚠️ Done, but CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set in bot env — add them manually to \`${repo}\` secrets.`);
      }

      // Fetch the repo's public key needed to encrypt secrets for the GitHub API
      const pubKeyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
        headers: {
          "Authorization": `Bearer ${env.GHPAT}`,
          "User-Agent": "Cloudflare-Worker-Telegram-Bot",
          "Accept": "application/vnd.github.v3+json"
        }
      });

      if (!pubKeyRes.ok) {
        return sendMessage(env, msg.chat.id, `⚠️ Workflow committed but couldn't fetch repo public key: ${await pubKeyRes.text()}`);
      }

      const { key: repoPublicKey, key_id } = await pubKeyRes.json();

      // Encrypt using libsodium crypto_box_seal — exactly what GitHub requires
      await _sodium.ready;
      const sodium = _sodium;
      function encryptSecret(secretValue) {
        const repoKeyBytes = Uint8Array.from(atob(repoPublicKey), c => c.charCodeAt(0));
        const secretBytes = new TextEncoder().encode(secretValue);
        const encrypted = sodium.crypto_box_seal(secretBytes, repoKeyBytes);
        return btoa(String.fromCharCode(...encrypted));
      }

      // Push each secret to the target repo
      async function pushSecret(name, value) {
        const encrypted = encryptSecret(value);
        const r = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${env.GHPAT}`,
            "User-Agent": "Cloudflare-Worker-Telegram-Bot",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ encrypted_value: encrypted, key_id })
        });
        return r.ok ? `✅ ${name}` : `❌ ${name} (${r.status})`;
      }

      const results = await Promise.all([
        pushSecret("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN),
        pushSecret("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID),
      ]);

      await sendMessage(env, msg.chat.id,
        `🔑 Secrets pushed to \`${repo}\`:\n${results.join('\n')}\n\nYour workflow is ready to deploy to Cloudflare! 🚀`
      );

    } catch (e) {
      await sendMessage(env, msg.chat.id, `❌ Error: ${e.message}`);
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
