# ADR 001: Rust rewrite and migration boundary

Status: Accepted\
Date: 2026-07-29

ASA V2 is a Rust workspace distributed as one `asa` executable. The executable
contains the human CLI, a deliberately small internal hook path, and the
foreground daemon entry point. Rust supplies predictable startup and memory
behavior, local IPC/daemon support, and release artifacts without a Node
runtime.

The TypeScript implementation remains temporarily as behavioral evidence and
an output oracle. It is not called from Rust and will not become a compatibility
layer. It can be retired only after the `list`, `analyze`, and `compare`
classifications below pass on the shared fixture corpus and packaging installs
the Rust binary.

Minimum supported Rust is 1.88. Initial release targets are Apple Silicon and
x86-64 macOS plus x86-64 Linux. Other targets require CI evidence.

## Existing command classification

| V1 command | Classification | Replacement condition |
|---|---|---|
| `list` | required before replacement | `sessions list` discovers native and observed sessions |
| `analyze` | required before replacement | equivalent core totals and tool/usage facts |
| `compare` | required before replacement | equivalent deltas for two analyses |
| `resume` | ported after replacement boundary | Rust launches the native CLI in the recorded cwd; interactive/headless argv matches V1 |
| whole-session `fork` | ported after replacement boundary | Rust delegates to each native CLI; interactive/headless argv matches V1 |
| mid-session `fork --at` | ported after replacement boundary | Rust writes a fresh disposable native transcript and preserves the source |
| crafted-context `fork` | ported after replacement boundary | deterministic digest, focus weighting, and native-shaped recent tail match V1 |
| `distill` | local core ported after replacement boundary | deterministic recurrence report is native; model suggestions and FAQ writes remain separately opt-in work |
| `prompter` | local core ported after replacement boundary | explicit native scan provides explainable metrics; model judge remains opt-in later work |
| `project` | local core ported after replacement boundary | repository-scoped usage, tools, and instruction inventory |
| `efficacy` | local core ported after replacement boundary | read-only Git instruction history joined to bounded steering windows |
| `intents` | local core ported after replacement boundary | deterministic opening-prompt taxonomy; model themes remain opt-in later work |
| `models` | local core ported after replacement boundary | parser-owned per-model attribution, favorites, weekly dominance, and switches |
| `sessions migrate-path` | ported after replacement boundary | collision-safe preflight, native metadata rewrite, backups, and resumable journal for both adapters |
| `setup` and git tracing | retire/replace | hooks and daemon management supersede it |
