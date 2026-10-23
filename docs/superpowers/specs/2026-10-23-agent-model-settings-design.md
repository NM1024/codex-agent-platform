# Agent model and reasoning selection

The user approved independent model and reasoning selection for each management conversation and each business plugin, inheriting their respective global settings by default.

Use Codex `model/list` to populate selectors and its supported reasoning efforts to populate dependent controls. A static list would drift from account capabilities; free text alone does not satisfy the requested selection experience. Retain saved models when the catalog cannot be loaded and clearly explain the unavailable catalog. Listing models must not start a model turn or expose credentials.

Global execution and manager settings gain optional `reasoningEffort` (null means model default). Plugin JSON gains optional `execution` with optional model and reasoningEffort. Conversation settings use the same override shape. Missing fields inherit; explicit null reasoning chooses the model default. A model-only override uses that model's default effort rather than inheriting an unrelated model's effort. Old persisted configurations and plugin definitions continue to work.

Plugin overrides are part of the accepted task contract. Resolve global settings with that snapshot at launch/resumption; changes never alter active execution. Persist the selected settings in task execution metadata. Conversation overrides apply to subsequent turns, and each started message records its settings for recovery and inspection.

Model catalog reads are authenticated preset operations, backed by a bounded, paginated Codex metadata call. No arbitrary shell or new business workflow is introduced. Explicit unsupported model/effort pairs are rejected before starting a turn. Catalog failure must be visible without preventing unrelated configuration edits.

Implement using the existing Node.js 24 services and vanilla Admin console. Verify inheritance, migration, plugin snapshots, new and resumed turns, model list pagination/failure, selectors, language switching and distributable resources using synthetic fixtures. Do not deploy locally or use an actual account.
