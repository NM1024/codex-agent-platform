let pending = "";
let writing = Promise.resolve();
function splitFrame(out) {
  // Responses may arrive out of request order, but a byte stream must finish
  // each JSON line before starting the next one. Keep deliberate split writes.
  writing = writing.then(async () => {
    process.stdout.write(out.slice(0, 8));
    await new Promise((resolve) => setTimeout(resolve, 2));
    process.stdout.write(out.slice(8));
  });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let n;
  while ((n = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, n);
    pending = pending.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "exit") process.exit(2);
    if (m.id === undefined) continue;
    if (m.method === "hang") continue;
    const result =
      m.method === "account/read"
        ? { account: { type: "chatgpt", email: "private@example.invalid" } }
        : m.method === "modelProvider/capabilities/read"
          ? { imageGeneration: true }
          : m.params;
    setTimeout(
      () => {
        const out = JSON.stringify({ id: m.id, result }) + "\n";
        splitFrame(out);
      },
      m.method === "slow" ? 30 : 0,
    );
  }
});
