# Prime Agent MVP rollout, drain, and rollback

## Staged rollout

1. Enable one named `prime-agent` instance on an environment with a supported binary.
2. Refresh status. The check is an isolated, read-only version/RPC handshake; **setup required** is expected without isolated credentials.
3. Start a normal thread and verify streaming, tool/interactions, interrupt and stop on each applicable client (web, desktop, mobile use/inspection).
4. Expand by environment/instance only after redacted evidence is retained. Do not enable a global provider switch.

## Emergency disable and drain

Set **Enabled** off for the affected Prime instance. This is Prime-only: do not stop the T3 server or other providers. Let existing owned turns drain where safe; use thread stop for an immediate user-requested stop. T3 only signals a captured PID after matching its recorded start token. It never pattern-kills or administers broad Prime daemons.

## Diagnostics and orphan safety

Collect the compatibility band, hash-only transcript, resource/PID manifest and ownership warning. Do not paste prompt text, tokens, credentials, raw stderr, raw paths, or account information. If exact ownership or PID identity cannot be proven, retain the resource and show an actionable orphan warning; investigate manually rather than deleting it.

## Rollback/downgrade

Disable Prime, drain/stop its proven owned work, and deploy the previous T3 version. Preserve Prime settings, ownership records, sessions and unknown/newer fields verbatim for a later compatible re-enable; do not rewrite them to an older schema. A downgrade cannot promise resume of unproved opaque provider state. Re-enable only after a fresh isolated check.
