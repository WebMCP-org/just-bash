---
"just-bash": minor
---

Support an explicit global symlink namespace for pure virtual MountableFs
backends while retaining mount-local resolution by default and preserving
host-backed symlink policies. Keep literal link targets through copies and
moves, and merge typed directory listings with virtual mount parents.

Delegate synchronous shell initialization to capable mounted backends, so an
asynchronous workspace can share Bash with in-memory system directories.

Export the existing pure filesystem codecs at `just-bash/fs/encoding` so custom
backends can use the same text/binary conversion rules as built-in backends.
