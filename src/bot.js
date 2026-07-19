import { seal } from 'tweetsodium';

const telegramApi = (token) => `https://api.telegram.org/bot${token}`;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

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

async function answerCallbackQuery(env, callbackQueryId, text) {
  return fetch(`${telegramApi(env.TELEGRAM_BOT_TOKEN)}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function editMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  return fetch(`${telegramApi(env.TELEGRAM_BOT_TOKEN)}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup })
  });
}

function actionsRepo(env) {
  return env.GITHUB_REPOSITORY || 'quickerup/telegram-worker-bot-template';
}

function branchContextKey(chatId) {
  return `branch-context:${chatId}`;
}

function encodeBranchRefPath(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

async function deleteRemoteBranch(env, repo, branch) {
  return githubRequest(env, `/repos/${repo}/git/refs/heads/${encodeBranchRefPath(branch)}`, {
    method: 'DELETE'
  });
}

async function getSelectedBranch(env, chatId) {
  if (!env.BRANCH_CONTEXT_KV) {
    return undefined;
  }

  return env.BRANCH_CONTEXT_KV.get(branchContextKey(chatId));
}

async function setSelectedBranch(env, chatId, branch) {
  if (!env.BRANCH_CONTEXT_KV) {
    console.warn('BRANCH_CONTEXT_KV binding is not configured; branch context will not persist.');
    return;
  }

  await env.BRANCH_CONTEXT_KV.put(branchContextKey(chatId), branch);
}

async function githubRequest(env, path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.GHPAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Worker-Telegram-Bot',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
}

async function triggerWorkflow(env, repo, workflow, branch) {
  const res = await githubRequest(env, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: branch })
  });

  if (res.ok) {
    return { ok: true, message: '✅ Successfully triggered workflow!' };
  }

  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    if (body.message && body.message.includes('workflow_dispatch')) {
      return {
        ok: false,
        message: `⚠️ Cannot trigger \`${workflow}\` manually — it doesn't have a \`workflow_dispatch\` trigger.\n\nIt will run automatically based on its own trigger (e.g. \`workflow_run\`, \`push\`, etc).`
      };
    }
    return { ok: false, message: `❌ Failed to trigger (HTTP 422):\n${body.message || JSON.stringify(body)}` };
  }

  return { ok: false, message: `❌ Failed to trigger (HTTP ${res.status}):\n${await res.text()}` };
}


async function handleBranchDeleteCallback(env, cb) {
  const prefix = 'delete_branch:';
  const branch = cb.data.slice(prefix.length).trim();

  if (!branch || !SAFE_BRANCH_PATTERN.test(branch)) {
    await answerCallbackQuery(env, cb.id, 'Invalid branch delete request');
    return;
  }

  if (!env.GHPAT) {
    await answerCallbackQuery(env, cb.id, 'GHPAT is not set');
    return;
  }

  await answerCallbackQuery(env, cb.id, `Deleting ${branch}...`);

  const repo = actionsRepo(env);
  const deleteRes = await deleteRemoteBranch(env, repo, branch);
  const chatId = cb.message?.chat?.id;

  if (!deleteRes.ok) {
    const body = await deleteRes.text();
    console.error(`[GitHub] Failed to delete branch ${branch} from ${repo}: ${deleteRes.status} ${body}`);
    if (chatId) {
      await sendMessage(env, chatId, `❌ Failed to delete remote branch: ${branch} (HTTP ${deleteRes.status})`);
    }
    return;
  }

  if (chatId) {
    await sendMessage(env, chatId, `💥 Successfully deleted remote branch: ${branch}`);
  }
}

async function handleBranchSelectionCallback(env, cb) {
  const prefix = 'select_branch:';
  const branch = cb.data.slice(prefix.length).trim();

  if (!branch || !SAFE_BRANCH_PATTERN.test(branch)) {
    await answerCallbackQuery(env, cb.id, 'Invalid branch selection');
    return;
  }

  const confirmation = `🎯 Switched context to branch: ${branch}`;
  await answerCallbackQuery(env, cb.id, confirmation);

  const chatId = cb.message?.chat?.id;
  if (!chatId) {
    return;
  }

  await setSelectedBranch(env, chatId, branch);
  await sendMessage(env, chatId, confirmation);

  const repo = actionsRepo(env);
  const workflow = env.GITHUB_WORKFLOW || 'deploy.yml';
  const triggerMessage = {
    ...cb.message,
    text: `/trigger ${repo} ${workflow} ${branch}`,
    from: cb.from || cb.message.from,
    chat: cb.message.chat
  };

  await commands.trigger(env, triggerMessage);
}

async function handleWorkflowCallback(env, cb) {
  if (!env.GHPAT) {
    await answerCallbackQuery(env, cb.id, 'GHPAT is not set');
    return;
  }

  const repo = actionsRepo(env);
  const [action, workflowId] = cb.data.split(':');
  if (!workflowId) {
    await answerCallbackQuery(env, cb.id, 'Invalid workflow action');
    return;
  }

  if (action === 'wr') {
    const res = await githubRequest(env, `/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: env.GITHUB_REF || 'main' })
    });
    await answerCallbackQuery(env, cb.id, res.ok ? 'Triggered ✅' : `Trigger failed (${res.status})`);
    return;
  }

  if (action === 'wd') {
    const workflowRes = await githubRequest(env, `/repos/${repo}/actions/workflows/${workflowId}`);
    if (!workflowRes.ok) {
      await answerCallbackQuery(env, cb.id, `Lookup failed (${workflowRes.status})`);
      return;
    }
    const workflow = await workflowRes.json();
    await answerCallbackQuery(env, cb.id, 'Confirm delete in chat');
    await sendMessage(env, cb.message.chat.id, `Delete workflow \`${workflow.name}\` at \`${workflow.path}\`?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Cancel', callback_data: `wc:${workflowId}` },
          { text: 'Confirm delete 🗑️', callback_data: `wD:${workflowId}` }
        ]]
      }
    });
    return;
  }

  if (action === 'wc') {
    await answerCallbackQuery(env, cb.id, 'Delete cancelled');
    if (cb.message) {
      await editMessageReplyMarkup(env, cb.message.chat.id, cb.message.message_id, { inline_keyboard: [] });
    }
    return;
  }

  if (action === 'wD') {
    const workflowRes = await githubRequest(env, `/repos/${repo}/actions/workflows/${workflowId}`);
    if (!workflowRes.ok) {
      await answerCallbackQuery(env, cb.id, `Lookup failed (${workflowRes.status})`);
      return;
    }
    const workflow = await workflowRes.json();
    const fileRes = await githubRequest(env, `/repos/${repo}/contents/${workflow.path}`);
    if (!fileRes.ok) {
      await answerCallbackQuery(env, cb.id, `File lookup failed (${fileRes.status})`);
      return;
    }
    const file = await fileRes.json();
    const deleteRes = await githubRequest(env, `/repos/${repo}/contents/${workflow.path}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `Delete ${workflow.path} via bot`, sha: file.sha })
    });
    await answerCallbackQuery(env, cb.id, deleteRes.ok ? 'Deleted 🗑️' : `Delete failed (${deleteRes.status})`);
    if (deleteRes.ok && cb.message) {
      await editMessageReplyMarkup(env, cb.message.chat.id, cb.message.message_id, { inline_keyboard: [] });
    }
  }
}

async function saveAndConfigureWorkflow(env, msg, repo, yaml) {
  const shortTime = Date.now().toString(36);
  const filename = `bot_${shortTime}.yml`;
  const path = `.github/workflows/${filename}`;

  // Validate basic YAML structure before committing
  const hasOn = /^on[: ]/m.test(yaml) || /^"on"[: ]/m.test(yaml);
  const hasJobs = /^jobs:/m.test(yaml);
  const hasSteps = /^\s+steps:/m.test(yaml);
  const stepsAtTopLevel = /^steps:/m.test(yaml);

  if (!hasJobs || stepsAtTopLevel) {
    console.error('[Validation] AI returned malformed YAML — missing jobs: or steps at top level');
    return sendMessage(env, msg.chat.id,
      '❌ Generated invalid YAML structure (missing `jobs:` or `steps:` at wrong level). Please try again.');
  }
  if (!hasOn) {
    console.warn('[Validation] YAML missing on: trigger — still committing but may fail');
  }

  await sendMessage(env, msg.chat.id, `✍️ Committing workflow to \`${path}\` on \`${repo}\`...`);

  // Auto-provision the repository if it doesn't exist
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
      message: `Add workflow via Telegram Bot`,
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

  function encryptSecret(secretValue) {
    const repoKeyBytes = Uint8Array.from(atob(repoPublicKey), c => c.charCodeAt(0));
    const secretBytes = new TextEncoder().encode(secretValue);
    const encrypted = seal(secretBytes, repoKeyBytes);
    return btoa(String.fromCharCode(...encrypted));
  }

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

  const workerName = (env.WORKER_NAME || 'telegram-worker-bot-template');
  const workerUrl = `https://${workerName}.${workerName}.workers.dev`;

  const results = await Promise.all([
    pushSecret("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN),
    pushSecret("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID),
    pushSecret("TELEGRAM_WORKER_URL", workerUrl),
    pushSecret("TELEGRAM_CHAT_ID", env.TELEGRAM_CHAT_ID || (() => { throw new Error("TELEGRAM_CHAT_ID env var is required"); })()),
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
      'Commands:\n/start - greet\n/help - this message\n/trigger [repo] [workflow] [branch] - trigger a GitHub action\n/makeworkflow [repo] [description] - use AI to design and commit a new workflow\n/import [repo] <yaml> - import a premade workflow file\n\nAnything else you send gets echoed back.'
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
    const branch = parts[3] || await getSelectedBranch(env, msg.chat.id) || env.GITHUB_REF || "main";

    await sendMessage(env, msg.chat.id, `Triggering \`${workflow}\` on \`${repo}\` (\`${branch}\`)...`);
    const result = await triggerWorkflow(env, repo, workflow, branch);
    await sendMessage(env, msg.chat.id, result.message);
  },
  import: async (env, msg) => {
    console.log(`[Command] /import from user ${msg.from.id}`);
    if (!env.GHPAT) {
      return sendMessage(env, msg.chat.id, "Please set GHPAT secret first.");
    }
    const match = msg.text.trim().match(/^\/import\s+([^\s]+)\s+([\s\S]+)$/);
    if (!match) {
      return sendMessage(env, msg.chat.id, "Usage:\n/import [owner/repo]\n<paste yaml here>");
    }
    const repo = match[1];
    let yaml = match[2].trim();
    if (yaml.startsWith("```")) {
      yaml = yaml.replace(/^```[a-z]*\n?/, "").replace(/\n```$/, "");
    }
    await saveAndConfigureWorkflow(env, msg, repo, yaml);
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
                content: [
                  'You are an expert GitHub Actions engineer. Return ONLY raw valid YAML for GitHub Actions. No markdown fences, no commentary. Output ONLY the YAML.',
                  '',
                  'REQUIRED TOP-LEVEL STRUCTURE — follow exactly, no exceptions:',
                  'name: <workflow name>',
                  'on: <trigger>',
                  'jobs:',
                  '  <job-id>:',
                  '    runs-on: ubuntu-latest',
                  '    steps:',
                  '      - name: <step name>',
                  '        run: <command>',
                  '',
                  'RULES: "on" and "jobs" MUST be top-level keys. "steps" MUST be nested inside a job under "jobs". NEVER place "steps" at the top level.',
                  'ALWAYS include workflow_dispatch as a trigger alongside any other triggers (e.g. workflow_run, push, schedule), so the workflow can always be manually fired:',
                  'on:',
                  '  workflow_dispatch:',
                  '  workflow_run:   # or push, schedule, etc',
                  '    ...',
                  'ALWAYS create a GitHub issue if any job in the workflow fails. Add `issues: write` permissions and a final job or step that runs on failure with `if: failure()` or `if: ${{ failure() }}` and uses the GitHub CLI or API to create a new issue for that failed run.',
                  '',
                  'ADDITIONAL RULES:',
                  '1. File Transfer: Use cpina/github-action-push-to-another-repository, not raw git commands.',
                  '2. Wrangler Isolation: Always update wrangler.toml name field in target repos.',
                  '3. Secrets: Seed TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID into target repos.',
                  '4. Repository Creation: Use GitHub API via curl.',
                  '5. Environment Variables: Define all env vars in each step env: block before use.',
                  '6. Worker URL: TELEGRAM_WORKER_URL is a Telegram webhook receiver — do NOT POST messages to it directly. It will not send Telegram messages.',
                  '7. Sending Telegram Messages from a workflow: Use the Telegram Bot API directly. Example step:',
                  '   env:',
                  '     BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}',
                  '   run: |',
                  '     curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \\',
                  '       -H "Content-Type: application/json" \\',
                  '       -d \'{"chat_id": ${{ secrets.TELEGRAM_CHAT_ID }}, "text": "your message here"}\'',
                ].join('\n')
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

      await saveAndConfigureWorkflow(env, msg, repo, yaml);
      console.log(`[makeworkflow] Completed successfully for ${repo}`);

    } catch (e) {
      console.error(`[Error] in /makeworkflow:`, e.stack || e.message);
      await sendMessage(env, msg.chat.id, `❌ Error: ${e.message}`);
    }
  },
};

export async function handleUpdate(update, env) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error("TELEGRAM_CHAT_ID environment variable is missing!");
    return;
  }
  const ALLOWED_CHAT_ID = parseInt(env.TELEGRAM_CHAT_ID, 10);

  // Handle callback queries (inline buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.message && cb.message.chat.id !== ALLOWED_CHAT_ID) return;
    
    console.log(`[Telegram] Received callback_query: ${cb.data}`);
    if (cb.data && cb.data.startsWith('select_branch:')) {
      await handleBranchSelectionCallback(env, cb);
    } else if (cb.data && cb.data.startsWith('delete_branch:')) {
      await handleBranchDeleteCallback(env, cb);
    } else if (cb.data && cb.data.startsWith('trig:')) {
      const match = cb.data.match(/^trig:([^:]+\/[^:]+):([^:]+)(?::(.+))?$/);
      if (!match) {
        await answerCallbackQuery(env, cb.id, 'Invalid trigger action');
        return;
      }
      const [, repo, workflow, callbackBranch] = match;
      const branch = callbackBranch || env.GITHUB_REF || 'main';
      await answerCallbackQuery(env, cb.id, 'Triggering workflow...');
      await sendMessage(env, cb.message.chat.id, `Triggering \`${workflow}\` on \`${repo}\` (\`${branch}\`)...`);
      const result = await triggerWorkflow(env, repo, workflow, branch);
      await sendMessage(env, cb.message.chat.id, result.message);
    } else if (cb.data && /^(wr|wd|wc|wD):/.test(cb.data)) {
      await handleWorkflowCallback(env, cb);
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
