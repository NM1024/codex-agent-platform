import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.mjs')&&name!=='deployment.test.mjs').sort().map(name=>'tests/'+name);
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit'});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code ?? 1;});
