---
"just-bash": minor
---

Add optional filesystem byte-range reads so head/tail byte requests do not load
entire native files. Stream supported filter pipelines with bounded queues,
downstream cancellation and isolated shell state, while retaining the general
executor for other shell compositions and preserving configured resource limits.
