import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
// Host adapter tests run on the Linux CI host, which supplies Python and Docker.
// Platform images intentionally do not contain those host administration tools.
const hostTests=new Set(['deployment.test.mjs','release-update.test.mjs','host-updater.test.mjs','sandbox-deployment.test.mjs','sandbox-runtime.test.mjs','sandbox-network.test.mjs']);
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.mjs')&&!hostTests.has(name)).sort().map(name=>'tests/'+name);
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit'});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code ?? 1;});
