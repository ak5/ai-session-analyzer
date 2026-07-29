# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for `ak5/ai-session-analyzer`. If that surface is
unavailable, contact the repository owner privately through the contact method
listed on the owner's GitHub profile.

Include the affected version or commit, reproduction steps, impact, and any
known mitigation. Do not include real credentials, private transcripts, access
tokens, or unrelated personal data.

## Sensitive-data boundaries

ASA reads agent transcripts and can install local hooks. Contributors MUST:

- use synthetic or deliberately sanitized fixtures in tracked files;
- keep `.e2e/`, `.asa/`, and repository-root `tmp/` free of committed secrets;
- use isolated `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `ASA_ROOT` values in tests;
- avoid printing bearer tokens or authentication files;
- preserve native transcripts unless an explicit user action owns the mutation;
- treat user-scoped hook changes as security-relevant persistent changes.

Never paste secret values into an issue, pull request, test log, or agent prompt.
