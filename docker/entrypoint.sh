#!/bin/sh
# First-start setup for the agent CLIs. $HOME is a volume, so this only changes files the first time.
set -e

WORKSPACE="${AOS_WORKSPACE:-/workspace}"
mkdir -p "$HOME/.codex" "$WORKSPACE"

# Agents commit in the workspace; give them an identity and let git work on mounted folders.
git config --global --get user.name >/dev/null 2>&1 || git config --global user.name "${GIT_AUTHOR_NAME:-Lakshya agent}"
git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "${GIT_AUTHOR_EMAIL:-agents@lakshya.local}"
git config --global --get safe.directory >/dev/null 2>&1 || git config --global --add safe.directory '*'

# The workspace belongs to this deployment: trust it up front so agents don't stop at a
# "trust this folder?" menu. Set AOS_TRUST_WORKSPACE=0 to answer those menus yourself.
if [ "${AOS_TRUST_WORKSPACE:-1}" = "1" ]; then
  # Claude Code: skip first-run onboarding and trust the workspace.
  bun -e '
    const f = `${process.env.HOME}/.claude.json`, ws = process.argv[1];
    const file = Bun.file(f);
    const c = (await file.exists()) ? await file.json() : {};
    c.hasCompletedOnboarding ??= true;
    c.projects ??= {};
    c.projects[ws] = { ...c.projects[ws], hasTrustDialogAccepted: true };
    await Bun.write(f, JSON.stringify(c, null, 2));
  ' "$WORKSPACE"
  # Codex
  grep -qF "[projects.\"$WORKSPACE\"]" "$HOME/.codex/config.toml" 2>/dev/null ||
    printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$WORKSPACE" >> "$HOME/.codex/config.toml"
fi

# Codex with an API key: log in once. (For a ChatGPT plan: docker compose exec lakshya codex login --device-auth)
if [ -n "$OPENAI_API_KEY" ] && command -v codex >/dev/null && ! codex login status >/dev/null 2>&1; then
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null && echo "codex: logged in with OPENAI_API_KEY"
fi

exec "$@"
