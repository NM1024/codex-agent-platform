#!/usr/bin/env python3
"""Local, auth-free ManagementAgent memory comparison. See README.md."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[3]
WORKER = pathlib.Path(__file__).with_name('worker.mjs')
PINNED_CODEX = '0.159.2'
MIB = 2 ** 20


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scratch', type=pathlib.Path, default=REPO / '.tmp/manager-memory-benchmark')
    parser.add_argument('--baseline', default='8db12f7')
    parser.add_argument('--codex-binary', type=pathlib.Path, default=REPO / 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')
    parser.add_argument('--short-turns', type=int, default=4)
    parser.add_argument('--long-turns', type=int, default=32)
    parser.add_argument('--reply-bytes', type=int, default=262144)
    parser.add_argument('--queue-count', type=int, default=2000)
    parser.add_argument('--native-count', type=int, default=6)
    args = parser.parse_args()
    args.scratch = args.scratch.resolve()
    args.codex_binary = args.codex_binary.resolve()
    if min(args.short_turns, args.long_turns, args.queue_count, args.native_count) < 1 or args.reply_bytes < 128:
        parser.error('counts must be positive; --reply-bytes must be >=128')
    if args.native_count > 6:
        parser.error('--native-count is capped at 6 to bound baseline real process fan-out')
    return args


def archive_baseline(args):
    revision = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=REPO, text=True).strip()
    baseline = args.scratch / 'baseline'
    stamp = baseline / 'benchmark-revision.txt'
    if stamp.exists():
        if stamp.read_text().strip() != revision:
            raise RuntimeError('Scratch contains another baseline; select a different --scratch')
        return revision
    if baseline.exists():
        raise RuntimeError('Unrecognized baseline directory; select a fresh --scratch')
    baseline.mkdir()
    archive = args.scratch / 'baseline.tar'
    subprocess.run(['git', 'archive', '--format=tar', '--output=' + str(archive), revision, 'src', 'prompts'], cwd=REPO, check=True)
    with tarfile.open(archive) as source:
        source.extractall(baseline, filter='data')
    archive.unlink()
    stamp.write_text(revision + '\n')
    return revision


def main():
    args = arguments()
    args.scratch.mkdir(parents=True, exist_ok=True)
    # Archived ESM source resolves dependencies through its parent directories.
    # Allow scratch outside this repository without copying node_modules.
    dependencies = args.scratch / 'node_modules'
    if not dependencies.exists():
        dependencies.symlink_to(REPO / 'node_modules', target_is_directory=True)
    revision = archive_baseline(args)
    version = subprocess.check_output([str(args.codex_binary), '--version'], text=True).strip()
    if version != 'codex-cli ' + PINNED_CODEX:
        raise RuntimeError(f'Expected pinned Codex {PINNED_CODEX}, got {version}')
    common = {'scratch': str(args.scratch), 'codexBinary': str(args.codex_binary)}
    results = {}

    def run(mode, spec, name):
        print('Running ' + name, flush=True)
        with (args.scratch / (name + '.jsonl')).open('w') as log, (args.scratch / (name + '.stderr')).open('w') as error:
            subprocess.run(['node', '--expose-gc', str(WORKER), mode, json.dumps(common | spec)], cwd=REPO, stdout=log, stderr=error, check=True, timeout=300)
        if mode == 'worker':
            raw = json.loads((args.scratch / (name + '.jsonl')).read_text().splitlines()[-1])['result']
            results[name] = summarize(raw)
            if raw['samples'][-1]['active'] or raw['samples'][-1]['running'] or raw['remainingChildProcesses']:
                raise RuntimeError(f'{name} left active executions or child processes')
            count = spec.get('quantity', 1)
            if not spec.get('stub') and raw['rows'] != [{'status': 'completed', 'n': count * 2}]:
                raise RuntimeError(f'{name} did not complete all real turns: {raw["rows"]}')
            if spec['version'] == 'current' and results[name]['peak']['active'] > 2:
                raise RuntimeError(f'{name} exceeded the default two execution slots')
            if spec.get('seed') and spec['version'] == 'current':
                resumed = next(call for call in raw['rpc'] if call['method'] == 'thread/resume')
                if resumed.get('turns') != 0 or resumed.get('excludeTurns') is not True:
                    raise RuntimeError(f'{name} returned native history on normal resume')

    def fixture(delay):
        error = (args.scratch / f'fixture-{delay}.stderr').open('w')
        log = (args.scratch / f'fixture-{delay}.jsonl').open('w')
        process = subprocess.Popen(['node', str(WORKER), 'fixture', json.dumps(common | {'size': args.reply_bytes, 'delay': delay})], cwd=REPO, stdout=subprocess.PIPE, stderr=error, text=True)
        first = process.stdout.readline()
        if not first:
            process.wait(timeout=10)
            error.close()
            raise RuntimeError('Fixture failed to start; check fixture stderr (loopback listen permission is required)')
        port = json.loads(first)['port']
        log.write(first)
        log.flush()

        def drain():
            for line in process.stdout:
                log.write(line)
                log.flush()

        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        return process, thread, log, error, f'http://127.0.0.1:{port}'

    def stop_fixture(state):
        process, thread, log, error, _ = state
        process.terminate()
        process.wait(timeout=10)
        thread.join(timeout=10)
        log.close()
        error.close()

    seeds = {}
    state = fixture(100)
    try:
        for turns in dict.fromkeys([args.short_turns, args.long_turns]):
            seed = args.scratch / f'seed-{turns}-{args.reply_bytes}'
            if not (seed / 'benchmark-thread.json').exists():
                if seed.exists():
                    raise RuntimeError(f'Incomplete seed: {seed}; remove this seed directory before retrying')
                run('seed', {'home': str(seed), 'base': state[-1], 'turns': turns}, f'seed-{turns}')
            seeds[str(turns)] = seed_manifest(seed)
            for branch in ['baseline', 'current']:
                name = f'{branch}-turns-{turns}'
                root = args.scratch / ('run-' + name)
                if root.exists():
                    shutil.rmtree(root)
                run('worker', {'version': branch, 'root': str(root), 'base': state[-1], 'seed': str(seed)}, name)
    finally:
        stop_fixture(state)

    for count in dict.fromkeys([2, args.queue_count]):
        for branch in ['baseline', 'current']:
            name = f'{branch}-quantity-{count}'
            root = args.scratch / ('run-' + name)
            if root.exists():
                shutil.rmtree(root)
            run('worker', {'version': branch, 'root': str(root), 'stub': True, 'quantity': count}, name)

    state = fixture(1000)
    try:
        for count in dict.fromkeys([2, args.native_count]):
            for branch in ['baseline', 'current']:
                name = f'{branch}-realquantity-{count}'
                root = args.scratch / ('run-' + name)
                if root.exists():
                    shutil.rmtree(root)
                run('worker', {'version': branch, 'root': str(root), 'base': state[-1], 'quantity': count}, name)
    finally:
        stop_fixture(state)

    hashes = {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest() for path in (REPO / 'src').rglob('*.mjs')}
    summary = {'metadata': {'baseline': revision, 'codexVersion': version, 'commandArgs': vars(args) | {'scratch': str(args.scratch), 'codex_binary': str(args.codex_binary)}, 'scope': 'isolated complete ManagementAgent + ManagerStore worker, not complete HTTP manager container', 'transport': 'direct pinned native binary, no npm launcher; separate loopback auth-free Responses fixture; isolated HOME/CODEX_HOME', 'sampling': '25ms target; /proc VmRSS/VmHWM plus smaps_rollup PSS/Anonymous; two GC calls before final idle sample', 'protocolBytes': 'serialized response result bytes excluding JSON-RPC envelope, counted without history-size stringify allocation'}, 'currentSourceHashes': hashes, 'seeds': seeds, 'results': results}
    (args.scratch / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print('\nConfiguration | worker RSS peak MiB | native RSS peak MiB | active executions')
    for name, result in results.items():
        print(f"{name} | {result['peak']['worker']['rss']/MIB:.1f} | {result['peak']['codex']['rss']/MIB:.1f} | {result['peak']['active']}")
    print('Full evidence: ' + str(args.scratch / 'summary.json'))


def summarize(raw):
    samples = raw['samples']
    initial = next(s for s in samples if s['label'] == 'initial-idle-gc')
    final = next(s for s in samples if s['label'] == 'final-idle-gc')
    peak = {'worker': {key: max(s['worker'][key] for s in samples) for key in ['rss', 'rssHwm', 'heapUsed', 'external', 'anonymous', 'privateDirty']}, 'codex': {key: max(sum(p[key] for p in s['codex']) for s in samples) for key in ['rss', 'pss', 'anonymous', 'privateDirty']}, 'combinedRss': max(s['worker']['rss'] + sum(p['rss'] for p in s['codex']) for s in samples), 'active': max(s['active'] for s in samples), 'running': max(s['running'] for s in samples), 'clients': max(s['clients'] for s in samples)}
    observed = {p['pid'] for s in samples for p in s['codex']}
    return {'spec': raw['spec'], 'initialIdleGc': initial, 'peak': peak, 'finalIdleGc': final, 'created': raw['created'], 'rpc': raw['rpc'], 'rows': raw['rows'], 'dbBytes': raw['dbBytes'], 'remainingChildProcesses': raw['remainingChildProcesses'], 'postRunPidsStillExist': [pid for pid in observed if pathlib.Path(f'/proc/{pid}').exists()]}


def seed_manifest(seed):
    files = [{'path': str(p.relative_to(seed)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in seed.rglob('*') if p.is_file()]
    text_bytes = 0
    for path in (seed / 'sessions').rglob('*.jsonl'):
        for line in path.open():
            item = json.loads(line)
            payload = item.get('payload', {})
            if item.get('type') == 'response_item' and payload.get('role') == 'assistant':
                text_bytes += sum(len(part.get('text', '').encode()) for part in payload.get('content', []))
    return {'assistantTextBytes': text_bytes, 'totalFileBytes': sum(f['bytes'] for f in files), 'files': files}


if __name__ == '__main__':
    main()
