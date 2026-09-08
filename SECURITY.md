# Security

Report sensitive issues through this repository's private vulnerability reporting feature. Include a minimal reproduction using synthetic data; do not post credentials or real session logs in public issues.

This is experimental local-agent software. It inherits Pi's local trust boundary: an agent with shell or file access can act with the permissions of its process. Scoped history grants restrict the history API, not arbitrary access through other tools. Writer locks are cooperative and do not constrain unpatched Pi processes or hostile local programs.

Session notes and original messages may contain private information. Relevant records are sent to configured providers during compaction or retrieval. The extension adds no telemetry endpoint or external storage service. Users control their credentials and should protect their session directory and migration copies.

Do not run patched and unpatched writers against the same session. Failed recovery can leave a lock for inspection; do not delete it solely because it is old. Keep the original when migrating, and never treat an opaque placeholder as verified evidence.
