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
    # gzip mtime=0 avoids machine/time dependent checksums.
    import gzip
    body=gzip.compress(raw,mtime=0)
    (output/name).write_bytes(body)
    digest=hashlib.sha256(body).hexdigest()
    helper=git('show',commit+':scripts/update-release.py').decode()
    bootstrap='#!/usr/bin/env bash\nset -euo pipefail\numask 077\nif [[ "${1:-update}" != update || "$#" -gt 2 ]]; then echo \'Usage: bash update.sh update [deployment-directory]\' >&2; exit 2; fi\ncommand -v python3 >/dev/null || { echo \'Install Python 3.10+ first (apt install python3).\' >&2; exit 1; }\nargs=(update --source "$PWD")\nif [[ -n "${2:-}" ]]; then args+=(--data "$2"); fi\npython3 -B - "${args[@]}" <<\'PLATFORM_RELEASE_UPDATE_PYTHON\'\n'+helper+'\nPLATFORM_RELEASE_UPDATE_PYTHON\n'
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
