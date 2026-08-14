# Prime Agent compatibility matrix (MVP draft)

The Prime provider uses a data-driven adapter-boundary compatibility decision before any RPC process is started.

| Installed version                     | Band                   | Behavior                                                                                |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| missing / unparseable                 | unknown / incompatible | unavailable; no RPC probe                                                               |
| below `0.7.2`                         | incompatible           | blocked; no RPC probe                                                                   |
| `0.7.2+known-bad` conformance fixture | incompatible           | blocked; no RPC probe                                                                   |
| `0.7.2`                               | compatible             | ready only after `get_state` and `get_available_models` succeed with at least one model |
| newer unknown                         | advisory               | usable only after the same required probes pass; warning remains visible                |

`0.7.2+known-bad` is a synthetic matrix fixture, not a claim about a published release. It keeps the known-bad data path executable and reviewable until a documented upstream defect needs an entry.

The probe runs both `--version` and RPC inside the same isolated namespace. It launches `prime-agent --mode rpc` with disposable `HOME`, working, and session directories. It sends only `get_state` and `get_available_models`, never login/logout, session mutation, prompts, or daemon-wide commands. All captured child resources and temporary directories are closed exactly. Failures are coarse and do not expose account, environment, secret, or host path details. A safe previous model catalog may remain with `availability: "stale"`.
