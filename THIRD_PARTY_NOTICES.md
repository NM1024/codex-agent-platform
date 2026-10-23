# Third-party software

The MIT license in this repository covers this platform's original source. Dependencies retain their own licenses; installing or distributing them does not relicense them as MIT.

| Direct dependency | Pinned version | Declared license | Source |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `@openai/codex` | 0.159.2 | Apache-2.0 | https://github.com/openai/codex |
| `ajv` | 8.20.0 | MIT | https://github.com/ajv-validator/ajv |
| `cron-parser` | 5.4.0 | MIT | https://github.com/harrisiirak/cron-parser |
| `sharp` | 0.35.5 | Apache-2.0 | https://github.com/lovell/sharp |

This table records the direct packages' declared licenses. The lockfile also pins transitive and platform-specific dependencies, which may have additional notices and licenses. Their license files are retained in installed packages and container images. The container base image includes Debian/Node components with their own license notices.

Codex CLI software licensing is distinct from access to OpenAI-hosted services. A deployment uses its operator's own account and is subject to the applicable service terms. No login credentials, third-party reference images or generated customer artifacts are part of this source distribution.
