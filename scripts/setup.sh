#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# One-time setup automation for the Telegram-bot-on-Workers template.
#
# Replaces the manual GitHub UI steps in the README:
#   1. Optionally creates a new repo from this template
#   2. Resolves your Worker's public URL UP FRONT via the Cloudflare API,
#      so there's no "deploy, fails, add WORKER_URL, deploy again" dance
#   3. Pushes all required secrets + the WORKER_URL variable via `gh`
#   4. Renames the worker in wrangler.toml if needed, commits, pushes
#   5. Triggers the deploy workflow and watches it run
#
# Prerequisites:
#   - GitHub CLI (`gh`), authenticated: gh auth login
#   - Run from inside a clone of this repo, OR pass --new-repo to create one
# ---------------------------------------------------------------------------

WORKER_NAME=""
REPO=""
NEW_REPO=""
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
TELEGRAM_WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"

usage() {
  cat <<EOF
Usage: scripts/setup.sh [options]

Options:
  --new-repo NAME         Create a new GitHub repo from this template ('gh repo create --template')
  --repo OWNER/NAME       Target an existing repo instead of the current directory's
  --worker-name NAME      Name for the Cloudflare Worker (default: repo name)
  -h, --help              Show this help

Any of these can be pre-set as env vars to skip interactive prompts:
  TELEGRAM_BOT_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_WEBHOOK_SECRET
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-repo) NEW_REPO="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --worker-name) WORKER_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI ('gh') is required: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }

# --- 1. Resolve target repo -------------------------------------------------
if [[ -n "$NEW_REPO" ]]; then
  echo "Creating $NEW_REPO from this template..."
  TEMPLATE_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  gh repo create "$NEW_REPO" --template "$TEMPLATE_REPO" --private --clone
  cd "$(basename "$NEW_REPO")"
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
elif [[ -n "$REPO" ]]; then
  : # use as given, assumes commands below are run with --repo flag only (no local clone needed for secrets/vars)
else
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
echo "Target repo: $REPO"

WORKER_NAME="${WORKER_NAME:-$(basename "$REPO")}"

# --- 2. Collect credentials --------------------------------------------------
prompt_if_empty() {
  local var_name="$1" prompt_text="$2" secret="${3:-false}"
  if [[ -z "${!var_name}" ]]; then
    if [[ "$secret" == "true" ]]; then
      read -rsp "$prompt_text: " value; echo
    else
      read -rp "$prompt_text: " value
    fi
    printf -v "$var_name" '%s' "$value"
  fi
}

prompt_if_empty TELEGRAM_BOT_TOKEN "Telegram bot token (from @BotFather)" true
prompt_if_empty CLOUDFLARE_API_TOKEN "Cloudflare API token" true
prompt_if_empty CLOUDFLARE_ACCOUNT_ID "Cloudflare Account ID" false

if [[ -z "$TELEGRAM_WEBHOOK_SECRET" ]]; then
  TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  echo "Generated a random TELEGRAM_WEBHOOK_SECRET."
fi

# --- 3. Work out the Worker's public URL up front ---------------------------
echo "Looking up your workers.dev subdomain..."
SUBDOMAIN=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  | grep -Eo '"subdomain"\s*:\s*"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [[ -z "$SUBDOMAIN" ]]; then
  echo "Couldn't determine your workers.dev subdomain automatically."
  read -rp "Enter it manually (the part before .workers.dev): " SUBDOMAIN
fi

WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
echo "Worker URL will be: $WORKER_URL"

# --- 4. Rename the worker in wrangler.toml, if we have a local checkout ----
if [[ -f wrangler.toml ]]; then
  sed -i.bak "s/^name = .*/name = \"$WORKER_NAME\"/" wrangler.toml && rm -f wrangler.toml.bak
  if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
    git add -A
    git commit -m "chore: configure worker name via setup script"
    git push
  fi
fi

# --- 5. Push secrets + variable to GitHub -----------------------------------
echo "Setting GitHub secrets on $REPO..."
gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO" --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --body "$CLOUDFLARE_ACCOUNT_ID"
gh secret set TELEGRAM_BOT_TOKEN --repo "$REPO" --body "$TELEGRAM_BOT_TOKEN"
gh secret set TELEGRAM_WEBHOOK_SECRET --repo "$REPO" --body "$TELEGRAM_WEBHOOK_SECRET"
gh variable set WORKER_URL --repo "$REPO" --body "$WORKER_URL"

# --- 6. Trigger the deploy workflow and watch it -----------------------------
echo "Triggering deploy workflow..."
gh workflow run deploy.yml --repo "$REPO"
sleep 5
RUN_ID=$(gh run list --repo "$REPO" --workflow=deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --repo "$REPO" --exit-status

echo ""
echo "Done. Your bot should be live at: $WORKER_URL"
echo "Go message it on Telegram to try it out."
