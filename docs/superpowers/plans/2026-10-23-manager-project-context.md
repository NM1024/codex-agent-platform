# Default concurrency and management project context

**Goal:** Default business concurrency to five and ensure management Agents, including existing customized conversations, receive current project operating rules.

**Architecture:** Keep persisted/operator-selected settings authoritative and align deployment/runtime fallbacks at five. Add a focused versioned Markdown project-context resource to every management thread start/resume alongside editable instructions and human-only connection rules. Dynamic capabilities, schemas and current state remain tool-discovered; do not grant source, shell, SQL or credential access.

**Audit findings:** The runtime does not automatically read the repository README. Existing saved Manager instructions override updated defaults. Only the human-only connection policy is currently injected independently. Lifecycle/request independence, model inheritance, schedule semantics, chat/image behavior and deployment boundaries need an equivalent always-current reference.

- [x] Test and align configuration, deployment and runtime defaults at five while retaining explicit and persisted values, including one.
- [x] Add failing start/resume coverage for custom saved instructions receiving current project rules. Add the project context resource, injection and concise authoritative tool descriptions; preserve custom instructions and all authorization boundaries.
- [x] Update documentation and required-resource checks; pass Node24 npm/release (240 total checks), browser (70) and packaged Docker (233) checks; review and resolve the schedule wording finding.
- [ ] Commit and update the existing unmerged testing PR.
