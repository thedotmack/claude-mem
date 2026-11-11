#!/usr/bin/env bash
#
# eve Chat Template — one-shot setup.
#
# Links the Vercel project, provisions Neon, registers
# the "Sign in with Vercel" OAuth app, sets every environment variable through
# the Vercel API, pulls them locally, and runs database migrations.
#
# The OAuth app is created via the Vercel API (email scope + callback URLs set
# automatically). If that API is unavailable, the script falls back to a guided
# manual dashboard flow.
#
# Requires: vercel CLI, node, pnpm, openssl. Run from the repo root:
#   ./scripts/setup.sh [team-slug]        # or: ./scripts/setup.sh --scope <team-slug>
# The team scope is optional; when omitted it is taken from the linked project.
#
set -euo pipefail

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# --- 0. Prerequisites -------------------------------------------------------
for cmd in vercel node pnpm openssl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd"; exit 1; }
done

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "eve requires Node.js 24 or newer. You are running $(node -v). Please upgrade Node.js and try again."
  exit 1
fi

# --- Optional team scope ----------------------------------------------------
# Accept the team slug as `--scope <slug>` or as the first positional argument.
# Everything (linking + all vercel api calls) is scoped to it. When omitted it
# is resolved from the linked project's team.
TEAM_SCOPE=""
case "${1:-}" in
  --scope) TEAM_SCOPE="${2:-}" ;;
  --scope=*) TEAM_SCOPE="${1#--scope=}" ;;
  -*) ;;
  ?*) TEAM_SCOPE="$1" ;;
esac
SCOPE_FLAGS=""
[ -n "$TEAM_SCOPE" ] && SCOPE_FLAGS="--scope $TEAM_SCOPE"

# --- 1. Dependencies --------------------------------------------------------
step "Installing dependencies"
pnpm install

# --- 2. Link the Vercel project --------------------------------------------
step "Linking Vercel project"
if [ ! -f .vercel/project.json ]; then
  vercel link $SCOPE_FLAGS
fi
PROJECT_ID=$(node -e 'console.log(require("./.vercel/project.json").projectId)')
TEAM_ID=$(node -e 'console.log(require("./.vercel/project.json").orgId)')

# json_field FIELD_PATH — read JSON from stdin and print a dotted field (or "").
json_field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const o=JSON.parse(s);console.log(process.argv[1].split(".").reduce((a,k)=>(a&&a[k]!=null)?a[k]:undefined,o)??"")}catch{console.log("")}})' "$1"
}

# api_get PATH — GET JSON, team-scoped; prints "" on failure, never aborts the
# script under `set -e`/`pipefail`. All vercel api calls use --scope (the team
# slug), which is more reliable than passing teamId as a query parameter.
api_get() { vercel api "$1" $SCOPE_FLAGS 2>/dev/null || true; }

# Resolve the team slug. Use the provided scope if any; otherwise look it up from
# the linked project's team (addressed by id in the path, so it needs no scope).
if [ -n "$TEAM_SCOPE" ]; then
  TEAM_SLUG="$TEAM_SCOPE"
else
  TEAM_SLUG=$(api_get "/v2/teams/$TEAM_ID" | json_field slug)
  [ -n "$TEAM_SLUG" ] && SCOPE_FLAGS="--scope $TEAM_SLUG"
fi
PROJECT_SLUG=$(api_get "/v9/projects/$PROJECT_ID" | json_field name)
[ -n "$PROJECT_SLUG" ] && echo "  project: $PROJECT_SLUG${TEAM_SLUG:+  (team: $TEAM_SLUG)}"

# set_env KEY VALUE TYPE TARGETS_JSON
# Builds the JSON body with node (proper escaping) and upserts via the API,
# which writes to all listed targets — including all Preview branches — without
# the Git-branch prompt that blocks `vercel env add`.
set_env() {
  node -e 'const [k,v,t,tg]=process.argv.slice(1);process.stdout.write(JSON.stringify({key:k,value:v,type:t,target:JSON.parse(tg)}))' \
    "$1" "$2" "$3" "$4" \
    | vercel api "/v10/projects/$PROJECT_ID/env?upsert=true" $SCOPE_FLAGS -X POST --input - >/dev/null
  echo "  set $1"
}

# provision_integration LABEL SLUG ENV_MARKER — install a Marketplace integration
# unless its env var is already present. Some integrations (e.g. Upstash) punt to
# the browser for additional setup and don't set their env vars until that
# finishes (the CLI also exits non-zero in that case). When the marker isn't set
# afterward, ask the user to finish in the browser and re-run — the idempotency
# checks throughout this script skip everything already completed.
provision_integration() {
  local label="$1" slug="$2" marker="$3"
  if vercel env ls $SCOPE_FLAGS 2>/dev/null | grep -q "$marker"; then
    echo "  $marker already present, skipping"
    return
  fi
  vercel integration add "$slug" $SCOPE_FLAGS || true
  if ! vercel env ls $SCOPE_FLAGS 2>/dev/null | grep -q "$marker"; then
    warn "$label needs additional setup in the browser — finish connecting it to this project."
    warn "Then re-run this script to continue (completed steps are detected and skipped)."
    exit 0
  fi
}

# --- 3. Provision required storage ------------------------------------------
step "Provisioning Neon Postgres"
provision_integration "Neon" neon DATABASE_URL

step "Provisioning Upstash Redis"
provision_integration "Upstash Redis" upstash-kv KV_REST_API_URL

# --- 4. Better Auth secret --------------------------------------------------
step "Setting BETTER_AUTH_SECRET"
set_env BETTER_AUTH_SECRET "$(openssl rand -base64 32)" encrypted '["production","preview","development"]'

# --- 5. Sign in with Vercel OAuth app ---------------------------------------
step "Sign in with Vercel OAuth app"
if vercel env ls $SCOPE_FLAGS 2>/dev/null | grep -q 'NEXT_PUBLIC_VERCEL_APP_CLIENT_ID'; then
  echo "  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID already set, skipping OAuth app setup"
else
  APPS_URL="https://vercel.com/${TEAM_SLUG:-dashboard}/~/settings/apps"

  # Register the app via the OAuth Apps API. The name and slug must be globally
  # unique, so the slug is derived from the project id. The email/profile/
  # offline_access, openid scopes are requested up front, and both callback forms are
  # registered: the local URL (redirectUris) and the linked project + path
  # (projectRedirectUris), which covers the project's production and preview domains.
  CLIENT_ID=""
  CLIENT_SECRET=""
  APP_SLUG=$(node -e 'const p=(process.argv[1]||"eve-chat").toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"");const s=(process.argv[2]||"").replace(/[^a-zA-Z0-9]/g,"").slice(-8).toLowerCase();console.log(((p?p+"-":"eve-chat-")+s).slice(0,60))' "$PROJECT_SLUG" "$PROJECT_ID")
  APP_NAME="${PROJECT_SLUG:-$APP_SLUG}"

  echo "  Registering OAuth app \"$APP_NAME\" via the Vercel API..."
  APP_JSON=$(node -e 'const [name,slug,projectId]=process.argv.slice(1);process.stdout.write(JSON.stringify({name,slug,scopes:["openid","email","profile","offline_access"],redirectUris:["http://localhost:3000/api/auth/callback/vercel"],projectRedirectUris:[{projectId,path:"/api/auth/callback/vercel"}]}))' "$APP_NAME" "$APP_SLUG" "$PROJECT_ID" \
    | vercel api "/oauth-apps" $SCOPE_FLAGS -X POST --input - 2>/dev/null) || APP_JSON=""
  CLIENT_ID=$(printf '%s' "$APP_JSON" | json_field clientId)

  if [ -n "$CLIENT_ID" ]; then
    echo "  created app: $CLIENT_ID"
  else
    # An app with this slug may already exist from a prior run; reuse it.
    CLIENT_ID=$(api_get "/oauth-apps/$APP_SLUG" | json_field clientId)
    [ -n "$CLIENT_ID" ] && echo "  reusing existing app: $CLIENT_ID"
  fi

  if [ -n "$CLIENT_ID" ]; then
    SECRET_JSON=$(echo '{}' | vercel api "/oauth-apps/$CLIENT_ID/secret?clientId=$CLIENT_ID" $SCOPE_FLAGS -X POST --input - 2>/dev/null) || SECRET_JSON=""
    CLIENT_SECRET=$(printf '%s' "$SECRET_JSON" | json_field clientSecret)
    if [ -n "$CLIENT_SECRET" ]; then
      echo "  generated client secret"
    else
      warn "Could not generate a client secret automatically (an app can hold at most two)."
      warn "Generate one in the dashboard and paste it: $APPS_URL"
      while [ -z "$CLIENT_SECRET" ]; do
        read -r -s -p "  Paste the client secret: " CLIENT_SECRET </dev/tty; echo
      done
    fi
  else
    warn "Could not register or find the OAuth app automatically."
  fi

  # Only write values we actually resolved, so a partial run never clears them.
  if [ -n "$CLIENT_ID" ]; then
    set_env NEXT_PUBLIC_VERCEL_APP_CLIENT_ID "$CLIENT_ID" plain '["production","preview","development"]'
  else
    warn "No client ID resolved; leaving NEXT_PUBLIC_VERCEL_APP_CLIENT_ID unchanged."
  fi
  if [ -n "$CLIENT_SECRET" ]; then
    set_env VERCEL_APP_CLIENT_SECRET "$CLIENT_SECRET" encrypted '["production","preview","development"]'
  else
    warn "No client secret resolved; leaving VERCEL_APP_CLIENT_SECRET unchanged."
  fi
fi

# --- 6. Better Auth URL (production origin) ---------------------------------
step "Resolving production domain for BETTER_AUTH_URL"
DOMAIN=$(api_get "/v9/projects/$PROJECT_ID/domains" \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=(JSON.parse(s).domains||[]);const m=d.find(x=>x.name.endsWith(".vercel.app"))||d[0];console.log(m?m.name:"")}catch{console.log("")}})')
if [ -n "$DOMAIN" ]; then
  set_env BETTER_AUTH_URL "https://$DOMAIN" plain '["production","preview"]'
  echo "  production domain: https://$DOMAIN"
else
  warn "Could not resolve a production domain. Set BETTER_AUTH_URL on Production/Preview manually."
fi

# --- 6b. Optional Vercel Connect integrations -------------------------------
connector_uid_from_json() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const o=JSON.parse(s);const c=o.connector||o;console.log(c.uid||c.id||"")}catch{console.log("")}})'
}

setup_optional_mcp_connector() {
  local label="$1" env_key="$2" create_arg="$3" connector_name="$4"
  local answer json uid

  step "Optional: $label MCP connector"
  if vercel env ls $SCOPE_FLAGS 2>/dev/null | grep -q "$env_key"; then
    echo "  $env_key already set, skipping $label setup"
    return
  fi

  read -r -p "  Set up the $label MCP connector now? [y/N] " answer </dev/tty
  case "${answer:-n}" in
    [yY]*)
      echo "  Creating connector (a browser may open to authorize $label)..."
      json=$(vercel connect create "$create_arg" --name "$connector_name" --format json) || json=""
      uid=$(printf '%s' "$json" | connector_uid_from_json)
      if [ -n "$uid" ]; then
        echo "  connector: $uid"
        vercel connect attach "$uid" --yes >/dev/null \
          || warn "Could not attach the connector automatically; attach it from the dashboard if needed."
        set_env "$env_key" "$uid" encrypted '["production","preview","development"]'
      else
        warn "Could not determine the connector UID. Create it manually and set $env_key."
      fi
      ;;
    *)
      echo "  Skipped. The app falls back to a connector named \"$connector_name\" if $env_key is unset."
      ;;
  esac
}

setup_optional_slack_connector() {
  local answer json uid

  step "Optional: Slack channel connector"
  if vercel env ls $SCOPE_FLAGS 2>/dev/null | grep -q 'SLACK_CONNECTOR'; then
    echo "  SLACK_CONNECTOR already set, skipping Slack setup"
    return
  fi

  read -r -p "  Set up the Slack channel connector now? [y/N] " answer </dev/tty
  case "${answer:-n}" in
    [yY]*)
      echo "  Creating Slack connector (a browser may open to install Slack)..."
      json=$(vercel connect create slack --name eve-chat-template --triggers --format json) || json=""
      uid=$(printf '%s' "$json" | connector_uid_from_json)
      if [ -n "$uid" ]; then
        echo "  connector: $uid"
        vercel connect attach "$uid" --triggers --trigger-path /eve/v1/slack --yes >/dev/null \
          || warn "Could not attach Slack triggers automatically; attach /eve/v1/slack from the dashboard if needed."
        set_env SLACK_CONNECTOR "$uid" encrypted '["production","preview","development"]'
      else
        warn "Could not determine the Slack connector UID. Create it manually and set SLACK_CONNECTOR."
      fi
      ;;
    *)
      echo "  Skipped. The app falls back to \"slack/eve-chat-template\" if SLACK_CONNECTOR is unset."
      ;;
  esac
}

setup_optional_slack_connector
setup_optional_mcp_connector "Notion" NOTION_CONNECTOR mcp.notion.com notion
setup_optional_mcp_connector "Linear" LINEAR_CONNECTOR https://mcp.linear.app/mcp linear
setup_optional_mcp_connector "Sentry" SENTRY_CONNECTOR https://mcp.sentry.dev/mcp sentry

# --- 7. Pull environment variables locally ----------------------------------
step "Pulling environment variables to .env.local"
vercel env pull .env.local --yes
# BETTER_AUTH_URL is only set for Production/Preview; local dev uses localhost.
if ! grep -q '^BETTER_AUTH_URL=' .env.local 2>/dev/null; then
  echo 'BETTER_AUTH_URL=http://localhost:3000' >> .env.local
  echo "  added BETTER_AUTH_URL=http://localhost:3000 for local dev"
fi

# --- 8. Ensure DATABASE_URL is available locally for migrations -------------
if ! grep -q '^DATABASE_URL=' .env.local 2>/dev/null; then
  warn "DATABASE_URL is not in .env.local — Neon marks it sensitive and enables it"
  warn "for Production/Preview only, so it is not pulled. Enable it for the"
  warn "Development environment in the dashboard, or paste the Neon connection string."
  read -r -p "Paste DATABASE_URL (leave empty to skip migrations): " DBURL
  if [ -n "$DBURL" ]; then
    grep -v '^DATABASE_URL=' .env.local > .env.local.tmp 2>/dev/null || true
    mv -f .env.local.tmp .env.local 2>/dev/null || true
    echo "DATABASE_URL=$DBURL" >> .env.local
  fi
fi

# --- 9. Database migrations -------------------------------------------------
if grep -q '^DATABASE_URL=' .env.local 2>/dev/null; then
  step "Running database migrations"
  set -a; . ./.env.local; set +a
  pnpm db:migrate
else
  warn "Skipping migrations — DATABASE_URL missing. Run 'pnpm db:migrate' after setting it."
fi

# --- 10. Done ---------------------------------------------------------------
step "Setup complete"
bold "Start the app:  pnpm dev"
