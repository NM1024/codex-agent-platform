import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { RequestStore } from "../src/core/store.mjs";
import { createRuntimeServer } from "../src/runtime/server.mjs";
import { RuntimeClient } from "../src/runtime/client.mjs";
import { createMcpHandler } from "../src/mcp/server.mjs";
import { HttpError } from "../src/errors.mjs";
import { mcpError } from "../src/mcp/errors.mjs";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
test("RuntimeClient accepts module-owned error descriptions without a business whitelist",async t=>{
  const description={code:'CUSTOM_MODULE_FAILURE',message:'Safe module explanation.',action:'Correct this module input.',retryable:true};
  const url=await listen(t,createServer((req,res)=>{
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:description}));
  }));
  const client=new RuntimeClient({url,token:'test'});
  await assert.rejects(client.request('/custom'),error=>{
    assert.ok(error instanceof HttpError);assert.equal(error.responseSettled,true);
    assert.deepEqual(error.publicToolError,description);
    const readable=mcpError(error,{operationStatus:'failed'});
    assert.equal(readable.code,description.code);assert.equal(readable.action,description.action);return true;
  });
});


test("runtime processor calls use the configured timeout rather than a fixed two minutes",async t=>{
  const server=createServer((req,res)=>{setTimeout(()=>res.end("{}"),200);});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client=new RuntimeClient({url:`http://127.0.0.1:${server.address().port}`,token:"fixture",toolTimeoutMs:25});
  const started=Date.now();
  await assert.rejects(client.process({name:"custom"}),error=>error.effectUnknown===true);
  assert.ok(Date.now()-started<2000);
});


test("runtime preserves module-owned structured field guidance",async t=>{
  const detail={code:"MODULE_BAD_FIELD",message:"The document has an invalid field.",action:"Correct the title.",retryable:true,
    fields:[{path:"/title",rule:"type",message:"Use a string.",private:"never expose"}]};
  const server=createServer((req,res)=>{res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({error:detail}));});
  const url=await listen(t,server);
  const client=new RuntimeClient({url,token:"fixture"});
  await assert.rejects(client.process({name:"custom"}),error=>{
    assert.deepEqual(error.publicToolError.fields,[{path:"/title",rule:"type",message:"Use a string."}]);return true;
  });
});
