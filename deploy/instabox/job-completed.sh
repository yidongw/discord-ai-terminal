#!/usr/bin/env bash
# Installed by configure-test-runners.py, root-owned and outside candidate code.
# Each listener owns its checkout, actions, mapping and temporary directory.
set -euo pipefail
WORK_ROOT=@WORK_ROOT@
CI_ROOT=@CI_ROOT@
# A setup failure may run this hook before the workflow exports CIU/CID. Use
# GitHub's run id directly; never scan/delete another queued job's test users.
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]] || { echo 'cleanup: invalid run id' >&2; exit 1; }
CIU=datci${GITHUB_RUN_ID}
if getent passwd "$CIU" >/dev/null; then
  sudo -n pkill -KILL -u "$CIU" 2>/dev/null || true
  sleep 1
  sudo -n userdel "$CIU" 2>/dev/null || true
fi
sudo -n rm -rf -- "$CI_ROOT/$CIU"
rm -rf -- "$WORK_ROOT/discord-ai-terminal" "$WORK_ROOT/_temp"
