# Prime Agent (MVP shipped)

Prime Agent support is shipped for a compatible installed host binary. Install and authenticate **on the T3 environment host**, then add a `prime-agent` provider in Settings on web or desktop and refresh its status. Mobile can use an already configured provider but cannot configure host authentication.

T3 starts each thread in its own T3-owned workspace/session namespace. It streams normal replies, supported tools and interaction prompts, and supports interrupt, continue, and stop. If setup is required, authenticate with Prime Agent itself on the host; T3 never asks a phone or browser for host credentials and never copies them from a client.

Disable the named Prime instance to stop/drain only its T3-owned Prime work. Existing threads remain visible and are not silently moved to another provider. Re-enable after fixing setup. See [the operations runbook](../../operations/prime-agent-rollout.md) for emergency disable, diagnostics, or rollback.

Alpha and Beta features in the usage contract remain proposed: native steering/queued work, durable resume and cross-device conflict recovery are not MVP guarantees.
