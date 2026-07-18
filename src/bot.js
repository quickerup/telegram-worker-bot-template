import { seal } from 'tweetsodium';

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
    console.log(`[Command] /start from user ${msg.from.id}`);
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
    console.log(`[Command] /makeworkflow from user ${msg.from.id}: ${msg.text}`);
    if (!env.GHPAT) {
      console.warn("GHPAT not set, aborting.");
      return sendMessage(env, msg.chat.id, "Please set GHPAT secret first.");
    } const parts = msg.text.trim().split(/\s+/);
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
                content: 'You are an expert GitHub Actions engineer. Return ONLY a raw, valid YAML workflow for GitHub Actions based on the user\'s request. Do not use markdown formatting like ```yaml, just output the raw text. Do not add any conversational text.\n\nCRITICAL BLUEPRINT FOR REPO CLONING / WORKER DEPLOYMENTS:\nIf the user asks to clone, duplicate, or deploy to a new repository, you MUST follow these rules to avoid bash/git errors:\n1. File Transfer: Do NOT use raw git clone/commit bash commands (which fail due to missing identity or empty commits). Instead, use the \'cpina/github-action-push-to-another-repository\' action.\n2. Wrangler Isolation: Before pushing, you MUST update wrangler.toml in the target repo to change the \'name\' field so it does not overwrite the production worker.\n3. Secrets: Ensure the target repo gets its own TELEGRAM_BOT_TOKEN via GitHub Secrets.\n4. Repository Creation: If creating a repo, use the GitHub API via curl.\n5. Environment Variables: Always define necessary environment variables in each step\'s env: block before using them in shell commands.\n6. Worker URL: The Cloudflare Worker URL is always available as ${{ secrets.TELEGRAM_WORKER_URL }}. Use this when any step needs to curl or ping the worker. Never leave TELEGRAM_WORKER_URL empty.'
              },
              { role: 'user', content: prompt }
            ]
          })
        }
      );

      if (!aiRes.ok) {
        return sendMessage(env, msg.chat.id, `❌ AI request failed (${aiRes.status}): ${await aiRes.text()}`);
      }

      const result = await aiRes.json();
      let yaml = result.result.response;
      console.log(`[AI] Successfully generated workflow (${yaml.length} chars)`);
      
      // Cleanup markdown if the AI still included it
      if (yaml.startsWith("```")) {
        yaml = yaml.replace(/^```[a-z]*\n?/, "").replace(/\n```$/, "");
      }

      const shortTime = Date.now().toString(36);
      const filename = `bot_${shortTime}.yml`;
      const path = `.github/workflows/${filename}`;

      await sendMessage(env, msg.chat.id, `✍️ Generated workflow. Committing to \`${path}\` on \`${repo}\`...`);

      // Auto-provision the repository if it doesn't exist (e.g., bot-sandbox)
      const repoCheck = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: {
          "Authorization": `Bearer ${env.GHPAT}`,
          "User-Agent": "Cloudflare-Worker-Telegram-Bot"
        }
      });
      
      if (repoCheck.status === 404) {
        console.log(`[GitHub] Repo ${repo} not found. Auto-provisioning...`);
        const repoName = repo.split('/')[1];
        const createRes = await fetch(`https://api.github.com/user/repos`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GHPAT}`,
            "User-Agent": "Cloudflare-Worker-Telegram-Bot",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: repoName, private: true, auto_init: true })
        });
        // Wait a couple seconds for GitHub to finish provisioning the repo
        await new Promise(r => setTimeout(r, 2000));
      }

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

      // Encrypt using tweetsodium (pure JS crypto_box_seal)
      function encryptSecret(secretValue) {
        const repoKeyBytes = Uint8Array.from(atob(repoPublicKey), c => c.charCodeAt(0));
        const secretBytes = new TextEncoder().encode(secretValue);
        const encrypted = seal(secretBytes, repoKeyBytes);
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

      // Build the worker URL to also seed as a secret
      const workerName = (env.WORKER_NAME || 'telegram-worker-bot-template');
      const workerUrl = `https://${workerName}.${workerName}.workers.dev`;

      const results = await Promise.all([
        pushSecret("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN),
        pushSecret("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID),
        pushSecret("TELEGRAM_WORKER_URL", workerUrl),
      ]);

      await sendMessage(env, msg.chat.id,
        `🔑 Secrets pushed to \`${repo}\`:\n${results.join('\n')}\n\nYour workflow is ready to deploy to Cloudflare! 🚀`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "🚀 Trigger Workflow", callback_data: `trig:${repo}:${filename}` }
            ]]
          }
        }
      );
      console.log(`[makeworkflow] Completed successfully for ${repo}`);

    } catch (e) {
      console.error(`[Error] in /makeworkflow:`, e.stack || e.message);
      await sendMessage(env, msg.chat.id, `❌ Error: ${e.message}`);
    }
  },
};

export async function handleUpdate(update, env) {
  const ALLOWED_CHAT_ID = 7952819982;

  // Handle callback queries (inline buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.message && cb.message.chat.id !== ALLOWED_CHAT_ID) return;
    
    console.log(`[Telegram] Received callback_query: ${cb.data}`);
    if (cb.data && cb.data.startsWith('trig:')) {
      const match = cb.data.match(/^trig:([^:]+\/[^:]+):(.+)$/);
      if (!match) return;
      const [, repo, workflow] = match;
      const fakeMsg = {
        chat: cb.message.chat,
        from: cb.from,
        text: `/trigger ${repo} ${workflow} main`
      };
      await commands.trigger(env, fakeMsg);
      // Acknowledge the button press
      await fetch(`${telegramApi(env.TELEGRAM_BOT_TOKEN)}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: 'Triggering workflow...' })
      });
    }
    return;
  }

  if (!update.message || !update.message.text) return;

  const msg = update.message;

  // STRICT AUTHORIZATION: Only allow commands from this specific chat ID
  if (msg.chat.id !== ALLOWED_CHAT_ID) {
    console.warn(`[Security] Ignored message from unauthorized chat ID: ${msg.chat.id}`);
    return;
  }

  console.log(`[Telegram] Received message: ${msg.text}`);
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
