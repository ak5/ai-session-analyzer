# ADR 002: Passive observation and native adapters

Status: Accepted\
Date: 2026-07-29

ASA observes Claude Code and Codex without influencing them. Hook handlers never
grant, deny, block, rewrite, inject, continue, or stop agent activity. All
configured events return the native neutral response even when parsing,
delivery, or storage fails.

Native adapters own hook decoding, neutral output, transcript discovery, and
transcript parsing. Core types do not parse agent payloads. Native IDs are used
where available and are namespaced (`claude-code:<id>`, `codex:<id>`).
Workspace paths are mutable attribution rather than identity. Unknown JSON
fields and missing optional fields are tolerated.

Claude Code and Codex CLI are supported initially. Desktop support is reported
only where a desktop surface demonstrably uses the same hook and transcript
runtime. OpenCode, Gemini CLI, and Copilot remain deferred.
