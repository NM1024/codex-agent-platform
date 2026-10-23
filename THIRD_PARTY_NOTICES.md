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

## Admin frontend

The Admin bundle includes React `19.3.1`, React DOM `19.3.1`, Ant Design `6.6.7`, React Markdown `10.1.0` and remark-gfm `4.0.1` (MIT), plus their bundled dependencies. Vite emits the full bundled dependency notices with every production build at `src/manager/web-dist/third-party-notices.md`, served as plain text at `/admin/third-party-notices.md`. These notices are copied into the runtime images alongside the bundle.

Build-only direct dependencies include TypeScript `7.0.2` (Apache-2.0), Vite `8.3.5` (MIT), `@vitejs/plugin-react` `6.1.2` (MIT), and the Node/React/React DOM type definitions (MIT). Their package license files remain in the build-stage installation; frontend build tools are not installed as runtime dependencies.
