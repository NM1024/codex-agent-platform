import { probeWithProcess } from "../src/codex/session.mjs";
const result = await probeWithProcess({ requireImage: false });
console.log(JSON.stringify(result));
if (!result.ready) process.exitCode = 1;
