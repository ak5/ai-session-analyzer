#!/usr/bin/env bash
# Protect `main` (production): require the quality-gates check, require a PR
# (no direct pushes — only dev → main release PRs), and forbid force-pushes/
# deletes. Idempotent — safe to re-run. Mirrors ak5/botyard's setup.
#
#   ./scripts/setup-branch-protection.sh [branch]   # default branch: main
set -euo pipefail

REPO="${REPO:-ak5/ai-session-analyzer}"
BRANCH="${1:-main}"

echo "==> Applying branch protection to ${REPO}@${BRANCH}"

gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["quality-gates"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON

echo "==> Done. Current protection:"
gh api "repos/${REPO}/branches/${BRANCH}/protection" \
  --jq '{required_checks: .required_status_checks.contexts, strict: .required_status_checks.strict, pr_required: (.required_pull_request_reviews != null), force_pushes: .allow_force_pushes.enabled}'
