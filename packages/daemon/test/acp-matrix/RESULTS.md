# Live runtime matrix results

The latest local run of [`acp-matrix.test.ts`](README.md) against every runtime the daemon
admitted on one Linux x86-64 host with KVM. These are facts about that host's installs,
logins and provider quota on the date below, not a support guarantee; rerun the suite to
refresh them.

- **Date:** 2026-09-28, `main` at `3b7a1aa16`–`d82c2f185` (#2624, #2628)
- **Runs:** one `AC_RUNTIME_MATRIX_TARGETS=<id>` invocation per runtime; rows marked † were
  rerun after a provider or install problem was cleared, and the latest run is shown
- **VM image:** `ghcr.io/agentconnect-md/runtime-sandbox-full:latest`, and `:v2.0.0-rc.13` for
  rows marked ‡ (the published `:latest` still predates the #2472 runtime pin refresh)

```
runtime            | caps life model pmode load perm usage memory sbox  vm mcp skills
-------------------+-------------------------------------------------------------
claude-acp         |    ✓    ✓     ✓     ✓    ✓    ✓     ✓      ✓    ✓   ✓   ✓      ✓
codex-acp          |    ✓    ✓     ✓     ✓    ✓    ·     ✓      ✓    ✓   ✓   ✓      ✓
devin              |    ✓    ✓     ·     ✓    ✓    ·     ✓      ✓    ✓   ✓   ✓      ✓
github-copilot-cli |    ✓    ✓     ·     ✓    ✓    ✓     ✓      ✓    ✓   ✓   ✓      ✓
grok-build         |    ✓    ✓     ✓     ·    ✓    ✓     ·      ✓    ✓   ✓   ✓      ✓
opencode †         |    ✓    ✓     ✓     ✓    ✓    ·     ✓      ✓    ✓   ✓   ✓      ✓
omp †              |    ✓    ✓     ✓     ✓    ✓    ·     ✓      ✓    ✓   ✓   ✓      ·
dsh-acp †          |    ✓    ✓     ✓     ✓    ✓    ·     ✓      ✓    ✓   ✓   ✓      ✗
cline ‡            |    ✓    ✓     ✓     ✓    ✓    ✓     ·      ✓    ✓   ✓   ·      ✗
kimi †             |    ✓    ✓     ✓     ✓    ✓    ·     ·      ✓    ✓   ·   ✓      ✓
qoder † ‡          |    ✓    ✓     ✓     ✓    U    U     ✓      ✓    U   U   ✓      U
qoder-cli † ‡      |    ✓    ✓     ✓     ✓    U    U     ✓      ✓    U   U   ✓      U
pi-acp             |    U    U     U     U    U    U     U      U    U   U   U      U
qwen-code          |    ✓    ✗     ✗     ✗    ✗    ✗     ✗      ✗    ✗   ✗   ✗      ✗
antigravity-acp    |    ✗    ✗     ✗     ✗    ✗    ✗     ✗      ✗    ✗   ✗   ✗      ✗

legend: ✓ real pass · degrade ~ n/a U provider unavailable ✗ fail
```

## Notes

- **Degrades (`·`)** are capabilities a runtime does not advertise or exercise: no ACP
  permission request for a file write (codex, devin, opencode, omp, dsh, kimi), a single or
  empty model list (devin, copilot), no mode selector (grok), no ACP usage object (grok,
  cline, kimi), no MCP transport (cline), no reviewed skills-CLI identity (omp), and a runtime
  the VM image does not ship (kimi).
- **cline** — `vm` fails on `:latest`, whose cline 3.0.61 defaults to a model a ChatGPT-account
  Codex login rejects; it passes on `:v2.0.0-rc.13` (cline 3.0.65). `skills` fails: the model
  returned an empty reply instead of following the installed skill.
- **dsh-acp** — `skills` fails: the reply was the MCP probe's token from a separate session,
  which suggests the adapter does not isolate ACP sessions. Not yet confirmed.
- **kimi** — `sbox` needs #2628 (the environment-scoped login file). The row predates the
  rotation fix in #2632; without it, a sandboxed launch can invalidate the host login.
  `skills` depends on the workspace having no stray `.git` above it: Kimi takes the nearest
  ancestor holding a `.git` entry as the project root.
- **qoder / qoder-cli** — the provider account reached its credit limit mid-run.
- **pi-acp** — the host login had expired (authentication required).
- **qwen-code** — every turn fails with an unexplained `Internal error`; not yet investigated.
- **antigravity-acp** — admitted from stored login state, but its archive-distributed
  executable is not installed and the suite does not install archives, so it cannot start.
- The quota classifier does not yet recognise "Insufficient Balance", so an exhausted
  DeepSeek balance shows as `✗` rather than `U`; the dsh-acp and omp rows are reruns after the
  balance was restored.
