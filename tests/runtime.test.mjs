import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";

test("native TLS clients have a readable system CA bundle with valid trust anchors", async () => {
  const bundlePath =
    process.env.SSL_CERT_FILE || "/etc/ssl/certs/ca-certificates.crt";
  const pem = await readFile(bundlePath, "utf8");
  const certificates =
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  assert.ok(
    certificates.length > 0,
    "System CA bundle must contain certificates",
  );
  assert.ok(
    certificates.some((value) => new X509Certificate(value).ca),
    "Native clients need CA trust anchors, not only Node bundled roots",
  );
});
