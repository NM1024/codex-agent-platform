#!/usr/bin/env python3
"""Build immutable official image artifacts from the four already-tested images."""
import argparse
import gzip
import json
from pathlib import Path
import shutil
import tempfile

import official_images as images


def create_bundle(source, output, revision, *, run=images.run_command, registry=False):
    source, output = Path(source), Path(output)
    version = images.json_object((source / 'package.json').read_text())['version']
    if not images.VERSION.fullmatch(version):
        raise images.ImageError('A stable version is required')
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'schema_version': 1, 'version': version, 'revision': revision, 'platform': images.PLATFORM,
                'archive': {'name': 'codex-agent-platform-images-v' + version + '-linux-amd64.tar.gz',
                            'size': 1, 'sha256': '0' * 64}, 'images': {}}
    for component in images.COMPONENTS:
        tag = 'codex-agent-platform-' + component + ':' + version
        result = images.json_object(run(['docker', 'image', 'inspect', tag], capture=True))
        if not isinstance(result, list) or len(result) != 1 or not images.digest(result[0].get('Id')):
            raise images.ImageError('Cannot identify official image')
        manifest['images'][component] = {'local_tag': tag, 'id': result[0]['Id'], 'registry': None}
    images.validate_manifest(manifest, version, revision)
    images.inspect_images(manifest, run)
    destination = output / manifest['archive']['name']
    with tempfile.TemporaryDirectory(prefix='official-bundle-', dir=output) as temporary:
        raw = Path(temporary) / 'images.tar'
        run(['docker', 'save', '--output', str(raw), *[manifest['images'][c]['local_tag'] for c in images.COMPONENTS]])
        with raw.open('rb') as src, destination.open('wb') as dst:
            with gzip.GzipFile(fileobj=dst, mode='wb', mtime=0, filename='') as compressed:
                shutil.copyfileobj(src, compressed, 1024 * 1024)
    manifest['archive'].update(size=destination.stat().st_size, sha256=images.sha256_file(destination))
    images.validate_manifest(manifest, version, revision)
    images.verify_archive(destination, manifest)
    path = output / 'container-images.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    checksum_path = output / 'SHA256SUMS'
    sums = images.checksums(checksum_path.read_text()) if checksum_path.exists() else {}
    sums.update({destination.name: manifest['archive']['sha256'], path.name: images.sha256_file(path)})
    checksum_path.write_text(''.join(value + '  ' + name + '\n' for name, value in sums.items()))
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'bundle'))
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--data', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--revision')
    args = parser.parse_args()
    if args.action == 'prepare':
        if args.data is None:
            parser.error('--data is required')
        version = images.json_object((args.source / 'package.json').read_text())['version']
        images.prepare(args.source, args.data, version)
        print('Official release images prepared: v' + version)
    else:
        if args.output is None or args.revision is None:
            parser.error('--output and --revision are required')
        print(create_bundle(args.source, args.output, args.revision))


if __name__ == '__main__':
    main()
