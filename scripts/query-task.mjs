import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { id: { type: "string" } } });
if (!values.id) {
  console.error("Use --id TASK_UUID");
  process.exitCode = 2;
} else {
  const url = `http://127.0.0.1:${process.env.PORT ?? 3004}/v2/tasks/${encodeURIComponent(values.id)}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${process.env.INGRESS_TOKEN}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
}
