// Explicit local test sink. Logs metadata only, never image Base64 or credentials.
import { createServer } from "node:http";
import { readJson, json, errorResponse, requireAuth } from "../src/http.mjs";
const token = process.env.MOCK_CALLBACK_TOKEN;
if (!token) throw new Error("MOCK_CALLBACK_TOKEN required");
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz" && req.method === "GET")
      return json(res, 200, { alive: true, requests });
    requireAuth(req, token);
    if (req.method !== "POST" || req.url !== "/callback")
      return json(res, 404, { error: "not_found" });
    const body = await readJson(req, 1500000);
    requests++;
    console.log(
      JSON.stringify({
        event: "mock_callback",
        requests,
        task_id: body.task_id,
        type: body.type,
      }),
    );
    json(res, 200, { accepted: true });
  } catch (e) {
    errorResponse(res, e);
  }
});
server.listen(Number(process.env.PORT ?? 3904), "0.0.0.0");
process.on("SIGTERM", () => server.close());
