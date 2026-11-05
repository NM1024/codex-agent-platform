#!/usr/bin/env python3
"""Create a stable release source asset from an exact Git revision, never the working tree."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile


def verify_release_identity(source, tag, verified_revision):
    """Bind a manual publication to the exact commit checked by its operator."""
    if not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag or ''):
        raise ValueError('A stable vX.Y.Z tag is required')
    if not re.fullmatch(r'[a-f0-9]{40}', verified_revision or ''):
        raise ValueError('The full commit SHA verified locally is required')
    source = Path(source)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != verified_revision:
        raise ValueError('Tagged source differs from the commit verified locally')
    if json.loads((source / 'package.json').read_text())['version'] != tag[1:]:
        raise ValueError('Tag and package version differ')
    return revision


def bootstrap_text(helper):
    return r'''#!/usr/bin/env bash
set -euo pipefail
umask 077
usage() { echo 'Usage: bash update.sh update [deployment-directory] [--method image|source]' >&2; exit 2; }
[[ "${1:-update}" == update ]] || usage
if [[ "$#" -gt 0 ]]; then shift; fi
args=(update --source "$PWD")
if [[ "$#" -gt 0 && "$1" != --* ]]; then args+=(--data "$1"); shift; fi
if [[ "$#" -gt 0 ]]; then
  [[ "$#" == 2 && "$1" == --method && ( "$2" == image || "$2" == source ) ]] || usage
  args+=(--method "$2")
fi
command -v python3 >/dev/null || { echo 'Install Python 3.10+ first (apt install python3).' >&2; exit 1; }
python3 -B - "${args[@]}" <<'PLATFORM_RELEASE_UPDATE_PYTHON'
''' + helper + '\nPLATFORM_RELEASE_UPDATE_PYTHON\n'


def package(revision, output):
    root=Path(__file__).resolve().parents[1]
    def git(*args):
        return subprocess.check_output(['git','-C',str(root),*args])
    commit=git('rev-parse','--verify',revision+'^{commit}').decode().strip()
    version=json.loads(git('show',commit+':package.json'))['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',version):
        raise ValueError('Release packaging requires stable package version X.Y.Z')
    tag='v'+version
    output=Path(output).resolve()
    output.mkdir(parents=True,exist_ok=True)
    name=f'codex-agent-platform-{tag}.tar.gz'
    # Explicit distributable roots; no .git, runtime data, local evidence or dependencies.
    paths=['package.json','package-lock.json','Dockerfile','Dockerfile.sandbox','compose.yaml','deploy.sh',
           '.dockerignore','.gitignore','.env.example','LICENSE','README.md','README.zh-CN.md',
           'src','frontend','prompts','scripts','docs','tests','playwright.config.mjs']
    raw=git('archive','--format=tar',f'--prefix=codex-agent-platform-{tag}/',commit,'--',*paths)
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        if any(not (member.isfile() or member.isdir()) for member in tar.getmembers()):
            raise ValueError('Release source must not contain symlinks or special files')
    # Older installed updaters do not derive the Git PAX comment after extraction.
    # Include the exact tested revision as data so their staged build hook can verify images.
    buffer=io.BytesIO(raw)
    with tarfile.open(fileobj=buffer,mode='a') as tar:
        marker=(commit+'\n').encode()
        item=tarfile.TarInfo(f'codex-agent-platform-{tag}/.release-revision')
        item.size=len(marker)
        item.mode=0o644
        item.mtime=0
        tar.addfile(item,io.BytesIO(marker))
    raw=buffer.getvalue()
    # gzip mtime=0 avoids machine/time dependent checksums.
    import gzip
    body=gzip.compress(raw,mtime=0)
    (output/name).write_bytes(body)
    digest=hashlib.sha256(body).hexdigest()
    helper=git('show',commit+':scripts/update-release.py').decode()
    bootstrap=bootstrap_text(helper)
    (output/'update.sh').write_text(bootstrap)
    bootstrap_digest=hashlib.sha256(bootstrap.encode()).hexdigest()
    (output/'SHA256SUMS').write_text(f'{digest}  {name}\n{bootstrap_digest}  update.sh\n')
    print(f'{tag} {commit}\n{output/name}\nSHA256 {digest}')
    return output/name


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision',default='HEAD')
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    package(args.revision,args.output)
