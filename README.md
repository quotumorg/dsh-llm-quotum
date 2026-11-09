# quotum for deepseek harness

seat inference first. payg is auxiliary and off by default.
requires dsh `0.2.2-rc.1`, node `>=24.9.0`, pnpm on path, and `@deepseek-ai/dsh-llm@0.2.2-rc.1`.
install: `dsh plugin --profile headless add github:quotumorg/dsh-llm-quotum#v0.1.0`.
the example patches ship in the package, `<examples>` below: `~/.dsh/profiles/headless/node_modules/@quotumorg/dsh-llm-quotum/examples/`.
choose one: export `QUOTUM_SEAT_KEY` for the default seat, or `QUOTUM_PAYG_KEY` for payg.
keys are read only from the configured environment reference, never the credential store or a key file.
for seat, run `dsh --profile headless --patch <examples>/seat-only.cordis.patch.yml "reply with quotum."`.
for payg only, use `--patch <examples>/payg-only.cordis.patch.yml` instead.
bundle activation uses `dsh.profile.bundles`; check the composed tree with `dsh --profile headless --dump-config` before a call.
seat sends messages, tools, model controls and its bearer key to `https://api.venice.ai/api/v1/chat/completions`.
payg sends those inputs and its own bearer key to `https://quotum.org/api/payg/v1/chat/completions`, plus a fresh idempotency uuid.
no discovery, automatic retries, or automatic fallback; each dispatched call makes one request.
output defaults and ceilings: seat 8192, payg 2048. explicit higher caps are lowered.
payg allows 60 messages, 32 tools and 8192 canonical input bytes; 32768 requires project long context and explicit config.
payg refuses stop sequences; both routes refuse explicit reasoning effort. routes are text only; model ids are starter ids, not entitlements.
usage and response spend go to masked json stderr when enabled; absent usage or spend stays unknown, pending stays pending.
a full headless agent can make auxiliary calls and exceed payg input limits; use the separate operator probe for one small call.
seat/day-key composition and route overlays: `examples/`.
