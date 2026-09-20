---
"just-bash": minor
---

Add optional filesystem byte-range reads so head/tail byte requests do not load
entire native files. Preserve full-file resource guards for legacy adapters,
including nested mounts, and charge all consumed input bytes.
