#!/usr/bin/env python3
"""Build immutable official image artifacts from the four already-tested images."""
import argparse
import gzip
import json
import re
from pathlib import Path
import shutil
import tempfile
import tarfile
import hashlib

import official_images as images


def identity(source, revision):
    version = images.json_object((Path(source) / 'package.json').read_text())['version']
    if not images.VERSION.fullmatch(version) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise images.ImageError('Stable version and exact tested revision are required')
    return {'version': version, 'revision': revision}


def inspect(ref, run):
    values = images.json_object(run(['docker', 'image', 'inspect', ref], capture=True))
    if not isinstance(values, list) or len(values) != 1 or not images.digest(values[0].get('Id')):
        raise images.ImageError('Cannot identify official image')
    return values[0]


def check(info, component, release):
    images.check_config({'architecture': info.get('Architecture'), 'os': info.get('Os'),
                         'config': info.get('Config', {})}, component, release)


def push_immutable(image_id, tag, run):
    try:
        run(['docker', 'pull', tag], capture=True)
    except images.ImageError as error:
        # Network/authentication failures must never authorize replacing a tag.
        reason = getattr(error, 'stderr', str(error)).lower()
        if not any(text in reason for text in ('manifest unknown', 'name unknown', 'not found')):
            raise
    else:
        if inspect(tag, run)['Id'] != image_id:
            raise images.ImageError('Refusing to replace an existing official image tag')
        return
    run(['docker', 'tag', image_id, tag])
    run(['docker', 'push', tag])


def restore_candidates(source, revision, *, run=images.run_command):
    """Reuse immutable candidates on reruns, then run normal checks on those IDs."""
    release = identity(source, revision)
    restored = []
    for component in images.COMPONENTS:
        candidate = images.REGISTRY + component + ':ci-' + revision
        try:
            run(['docker', 'pull', candidate], capture=True)
        except images.ImageError:
            continue
        info = inspect(candidate, run)
        check(info, component, release)
        run(['docker', 'tag', info['Id'], 'codex-agent-platform-' + component + ':' + release['version']])
        restored.append(component)
    return restored


def publish_candidates(source, revision, *, run=images.run_command):
    release = identity(source, revision)
    for component in images.COMPONENTS:
        info = inspect('codex-agent-platform-' + component + ':' + release['version'], run)
        check(info, component, release)
        push_immutable(info['Id'], images.REGISTRY + component + ':ci-' + revision, run)


def promote(source, revision, *, run=images.run_command):
    release = identity(source, revision)
    result = {}
    # Check every candidate before publishing stable tags.
    candidates = {}
    for component in images.COMPONENTS:
        candidate = images.REGISTRY + component + ':ci-' + revision
        run(['docker', 'pull', candidate])
        info = inspect(candidate, run)
        check(info, component, release)
        candidates[component] = info['Id']
    for component, image_id in candidates.items():
        stable = images.REGISTRY + component + ':' + release['version']
        push_immutable(image_id, stable, run)
        info = inspect(stable, run)
        prefix = images.REGISTRY + component + '@sha256:'
        refs = [value for value in info.get('RepoDigests', []) if isinstance(value, str) and value.startswith(prefix) and images.digest(value.split('@')[-1])]
        if len(set(refs)) != 1:
            raise images.ImageError('Cannot identify published official registry digest')
        result[component] = refs[0]
        run(['docker', 'tag', image_id, 'codex-agent-platform-' + component + ':' + release['version']])
    return result


def create_bundle(source, output, revision, *, run=images.run_command, registry=None):
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
        manifest['images'][component] = {'local_tag': tag, 'id': result[0]['Id'], 'config_id': result[0]['Id'], 'registry': registry.get(component) if registry else None}
    images.validate_manifest(manifest, version, revision)
    for component in images.COMPONENTS:
        check(inspect(manifest['images'][component]['local_tag'], run), component, manifest)
    destination = output / manifest['archive']['name']
    with tempfile.TemporaryDirectory(prefix='official-bundle-', dir=output) as temporary:
        raw = Path(temporary) / 'images.tar'
        run(['docker', 'save', '--output', str(raw), *[manifest['images'][c]['local_tag'] for c in images.COMPONENTS]])
        with tarfile.open(raw) as tar:
            entries = images.json_object(tar.extractfile('manifest.json').read())
            for item in entries:
                tags = item.get('RepoTags', [])
                if len(tags) != 1: raise images.ImageError('Unexpected exported image tags')
                tag = tags[0].removeprefix('docker.io/library/')
                component = next((c for c in images.COMPONENTS if manifest['images'][c]['local_tag'] == tag), None)
                if component is None: raise images.ImageError('Unexpected exported image tag')
                config = tar.extractfile(item['Config']).read(2 * 1024 * 1024 + 1)
                if len(config) > 2 * 1024 * 1024: raise images.ImageError('Oversized image config')
                manifest['images'][component]['config_id'] = 'sha256:' + hashlib.sha256(config).hexdigest()
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
    parser.add_argument('action', choices=('prepare', 'bundle', 'revision', 'candidates', 'promote', 'cleanup', 'restore'))
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--data', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply and args.action != 'cleanup':
        parser.error('--apply is only valid for cleanup')
    if args.action == 'cleanup':
        tags = images.cleanup(apply=args.apply)
        print(('Removed' if args.apply else 'Preview; nothing removed') + ': ' + str(len(tags)) + ' old project image tags')
        for tag in tags: print(tag)
    elif args.action == 'revision':
        try: print(images.source_revision(args.source))
        except images.ImageError: print('unknown')
    elif args.action == 'prepare':
        if args.data is None:
            parser.error('--data is required')
        version = images.json_object((args.source / 'package.json').read_text())['version']
        images.prepare(args.source, args.data, version)
        print('Official release images prepared: v' + version)
    elif args.action in ('candidates', 'restore'):
        if args.revision is None:
            parser.error('--revision is required')
        if args.action == 'restore':
            print(json.dumps(restore_candidates(args.source, args.revision)))
        else:
            publish_candidates(args.source, args.revision)
    else:
        if args.output is None or args.revision is None:
            parser.error('--output and --revision are required')
        registry = promote(args.source, args.revision) if args.action == 'promote' else None
        print(create_bundle(args.source, args.output, args.revision, registry=registry))


if __name__ == '__main__':
    main()
