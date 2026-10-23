import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("Compose separates credentials, persists volumes and only binds gateway loopback", async () => {
  const compose = await readFile(join(root, "compose.yaml"), "utf8");
  assert.match(compose, /127\.0\.0\.1/);
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      join(root, ".env.example"),
      "-f",
      join(root, "compose.yaml"),
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const gateway = config.services.gateway,
    runner = config.services.runner;
  assert.ok(config.services.manager,'manager is an independent service');
  assert.equal(config.services.manager.ports[0].host_ip,'127.0.0.1');
  assert.equal(config.services.manager.user,'1000:1000');
  assert.ok(config.services.manager.volumes.some(volume=>volume.target==='/management'));
  assert.equal(config.services.manager.environment.PLATFORM_HTTP_TARGETS_JSON,undefined);
  assert.equal(gateway.ports[0].host_ip, "127.0.0.1");
  assert.equal(runner.ports, undefined);
  assert.ok(
    [...gateway.tmpfs, ...runner.tmpfs].every((mount) => mount.startsWith("/")),
  );
  assert.equal(gateway.environment.CODEX_HOME, undefined);
  assert.equal(runner.environment.PLATFORM_HTTP_TARGETS_JSON, undefined);
  assert.equal(runner.environment.INGRESS_TOKEN, undefined);
  assert.equal(
    gateway.volumes.find((v) => v.target === "/workspace").read_only,
    true,
  );
  assert.equal(runner.user, "1000:1000");
  assert.equal(gateway.user, "1000:1000");
  assert.equal(runner.privileged, undefined);
  assert.ok(!JSON.stringify(config).includes("/var/run/docker.sock"));
  assert.equal(
    runner.volumes.find((v) => v.target === "/codex").read_only,
    undefined,
  );
});
test("init creates private, distinct tokens, retains configuration and never destroys data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aw-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = ["init", dir];
  const result = spawnSync("bash", [join(root, "deploy.sh"), ...command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const env = await readFile(join(dir, ".env"), "utf8");
  const tokens = [
    ...env.matchAll(
      /^(?:INGRESS_TOKEN|RUNNER_TOKEN)=(.+)$/gm,
    ),
  ].map((m) => m[1]);
  assert.equal(tokens.length, 2);
  assert.equal(new Set(tokens).size, 2);
  assert.ok(tokens.every((x) => x.length >= 48));
  assert.equal((await stat(join(dir, ".env"))).mode & 0o777, 0o600);
  const initialPassword=await readFile(join(dir,'manager/initial-password'),'utf8');
  assert.ok(initialPassword.trim().length>=24);assert.ok(!tokens.includes(initialPassword.trim()));
  assert.equal((await stat(join(dir,'manager/initial-password'))).mode&0o777,0o600);
  assert.equal(
    spawnSync("bash", [join(root, "deploy.sh"), ...command]).status,
    0,
  );
  assert.equal(await readFile(join(dir, ".env"), "utf8"), env);
  assert.equal(await readFile(join(dir,'manager/initial-password'),'utf8'),initialPassword);
  assert.ok((await stat(join(dir,'manager'))).isDirectory());
});
test('init adds an initial Admin password to an existing installation without changing its env',async t=>{
  const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'aw-existing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'.env'),'EXISTING_CONFIG=retained\n');
  const result=spawnSync('bash',[join(root,'deploy.sh'),'init',dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(dir,'.env'),'utf8'),'EXISTING_CONFIG=retained\n');assert.ok((await readFile(join(dir,'manager/initial-password'),'utf8')).trim().length>=24);
});
test('release validates dynamic plugin JSON and manager web resources',async t=>{
  const {cp,unlink,writeFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'aw-platform-release-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await cp(join(root,'src'),join(dir,'src'),{recursive:true});await cp(join(root,'scripts'),join(dir,'scripts'),{recursive:true});await cp(join(root,'prompts'),join(dir,'prompts'),{recursive:true});
  const run=()=>spawnSync(process.execPath,[join(root,'scripts/check-release.mjs')],{cwd:dir,encoding:'utf8'});
  assert.equal(run().status,0);
  const definition=join(dir,'src/plugins/examples/novel.illustrated.json');const original=await readFile(definition);
  await unlink(definition);const missing=run();assert.notEqual(missing.status,0);assert.match(missing.stderr,/novel\.illustrated/);
  await writeFile(definition,original);await unlink(join(dir,'src/manager/web/app.js'));
  const web=run();assert.notEqual(web.status,0);assert.match(web.stderr,/app\.js/);
  await cp(join(root,'src/manager/web/app.js'),join(dir,'src/manager/web/app.js'));
  for(const name of ['manager','task','task-resume','manager-resume','task-investigation']) {
    const file=join(dir,'prompts',name+'.md'),text=await readFile(file);
    await unlink(file);const missingPrompt=run();assert.notEqual(missingPrompt.status,0);assert.ok(missingPrompt.stderr.includes('prompts/'+name+'.md'),missingPrompt.stderr);
    await writeFile(file,text);
  }
  assert.equal(run().status,0);
});

test("release ignore rules retain Codex source modules and exclude runtime authentication", async (t) => {
  const { mkdir, writeFile, copyFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "aw-release-ignore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(
    spawnSync("git", ["init", "--quiet", dir], { encoding: "utf8" }).status,
    0,
  );
  await copyFile(join(root, ".gitignore"), join(dir, ".gitignore"));
  await mkdir(join(dir, "src", "codex"), { recursive: true });
  await mkdir(join(dir, "codex"));
  await writeFile(join(dir, "src", "codex", "session.mjs"), "export {};");
  await writeFile(join(dir, "codex", "auth.json"), "{}");
  const source = spawnSync(
    "git",
    [
      "-c",
      "core.excludesFile=/dev/null",
      "check-ignore",
      "--quiet",
      "src/codex/session.mjs",
    ],
    { cwd: dir },
  );
  assert.equal(source.status, 1, "src/codex must be included in Git releases");
  assert.equal(
    spawnSync(
      "git",
      [
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "--quiet",
        "codex/auth.json",
      ],
      { cwd: dir },
    ).status,
    0,
    "Runtime authentication must remain ignored",
  );
});

test("release validation rejects missing relative modules before building a runnable image", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "aw-release-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "src", "codex"), { recursive: true });
  await mkdir(join(dir, "scripts"));
  await writeFile(
    join(dir, "src", "main.mjs"),
    'import {probeCodex} from "./codex/session.mjs";',
  );
  const script = join(root, "scripts", "check-release.mjs");
  const missing = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /src\/codex\/session\.mjs/);
  await writeFile(
    join(dir, "src", "codex", "session.mjs"),
    "export function probeCodex() {}",
  );
  const complete = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(complete.status, 0, complete.stderr);
  await writeFile(
    join(dir, "src", "main.mjs"),
    'new URL(\n  "./prompt.md",\n  import.meta.url,\n);',
  );
  const missingPrompt = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.notEqual(
    missingPrompt.status,
    0,
    "runtime prompts must be part of the release",
  );
  await writeFile(join(dir, "src", "prompt.md"), "complete task instructions");
  assert.equal(spawnSync(process.execPath, [script], { cwd: dir }).status, 0);
});
