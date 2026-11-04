import {execFileSync} from 'node:child_process';
import {releaseEvidence} from './ci-policy.mjs';
const [repo,sha]=process.argv.slice(2);
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo??'')||!/^[0-9a-f]{40}$/.test(sha??''))throw new Error('Repository and exact commit SHA required');
const api=path=>JSON.parse(execFileSync('gh',['api','--paginate','--slurp',path],{encoding:'utf8'}));
const runs=api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`).flatMap(page=>page.workflow_runs??[]);
let proof;
for(const run of runs){
 if(run.head_sha!==sha||run.conclusion!=='success')continue;
 const jobs=api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).flatMap(page=>page.jobs??[]);
 if(releaseEvidence(run,jobs,sha)){proof=run;break;}
}
if(!proof)throw new Error('No successful release verification on this exact commit. Run CI in release or full mode for the tag before publishing.');
console.log('Verified release evidence: '+proof.html_url);
