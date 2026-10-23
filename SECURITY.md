# Security

Do not include credentials, login files, production data or unredacted logs in public issues. For a vulnerability, use GitHub's private vulnerability reporting for this repository if enabled; otherwise contact the maintainer through a private channel listed on their GitHub profile before sharing exploit details.

Runtime credentials and data belong outside the source repository. `.gitignore` and Docker's build allowlist exclude runtime state, but always inspect staged changes before publishing. Protect deployment volumes and backups; stored HTTP destination tokens and account login state are sensitive.

Use a trusted HTTPS reverse proxy for remote access. Keep the internal Runner/Gateway MCP ports private. Admin has an independent password and expiring sessions; API Bearer tokens are separate credentials. Rotating one does not rotate the others.

Only preset capabilities are available to Agents. Plugin instructions and input are still untrusted content: review installed plugins and named HTTP targets according to your deployment's needs. Tool boundaries reduce exposure; they do not establish a guarantee that arbitrary prompts are safe.

This preview is tested with synthetic inputs and local services. Security scans are useful checks, not a guarantee that no vulnerability exists. OpenAI account usage and capabilities are governed by the service's own terms.
