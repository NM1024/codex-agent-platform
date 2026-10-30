# Project instructions

- Read README.md and docs/ARCHITECTURE.md before changing runtime behavior.
- Keep task lifecycle, plugin contracts, capabilities, delivery and management separate. Platform code must not impose a business workflow or image retry counts.
- Each API request is independent. Normal execution sends one complete initial message. Restart recovery may resume the same incomplete Codex thread; terminal tasks never restart automatically.
- Business plugins are JSON data: input/output schemas, instructions and explicit capabilities. Agents use the provided MCP operations and permitted Codex native tools. Management Agents may write code and run tests only through the conversation-scoped isolated sandbox tools. Do not add host shell, direct SQL, platform source-write or arbitrary Docker access; sandbox code never receives platform credentials.
- Use Node.js 24. Run npm test and npm run check:release; verify distributable files and Docker targets for release changes.
- Use synthetic data and local callback sinks in tests. Never read actual login credentials or submit real tasks with an account unless explicitly authorized.
- Use reserved example domains and synthetic identifiers in built-in examples, interface help and repository documentation. Do not copy real user domains, server names or deployment details into examples. Keep legitimate repository and upstream documentation links.
- Keep logs, probe output, browser captures and other temporary files in .tmp/, outside the distributable source. Never commit runtime databases, .env files, login state, passwords, certificates or keys.
