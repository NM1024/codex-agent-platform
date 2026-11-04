"""Fixed official-image release transport. No user-selected registry or host API."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

REPO = 'NM1024/codex-agent-platform'
SOURCE = 'https://github.com/' + REPO
REGISTRY = 'ghcr.io/nm1024/codex-agent-platform-'
COMPONENTS = ('gateway', 'runner', 'manager', 'sandbox')
PLATFORM = 'linux/amd64'
MAX_ARCHIVE = 2 * 1024 ** 3
SHA = re.compile(r'[a-f0-9]{64}')
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')


class ImageError(ValueError):
    pass


def json_object(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ImageError('Duplicate image metadata field')
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs)


def fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ImageError('Invalid official image metadata fields')


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value) is not None


def validate_manifest(value, version, revision=None):
    fields(value, ('schema_version', 'version', 'revision', 'platform', 'archive', 'images'))
    if (type(value['schema_version']) is not int or value['schema_version'] != 1 or
            not isinstance(version, str) or not VERSION.fullmatch(version) or value['version'] != version or
            not isinstance(value['revision'], str) or not re.fullmatch(r'[a-f0-9]{40}', value['revision']) or
            revision is not None and value['revision'] != revision or value['platform'] != PLATFORM):
        raise ImageError('Official image version, revision or platform does not match')
    archive = value['archive']
    fields(archive, ('name', 'size', 'sha256'))
    if (archive['name'] != 'codex-agent-platform-images-v' + version + '-linux-amd64.tar.gz' or
            type(archive['size']) is not int or not 0 < archive['size'] <= MAX_ARCHIVE or
            not isinstance(archive['sha256'], str) or not SHA.fullmatch(archive['sha256'])):
        raise ImageError('Invalid official image archive')
    fields(value['images'], COMPONENTS)
    for component in COMPONENTS:
        image = value['images'][component]
        fields(image, ('local_tag', 'id', 'config_id', 'registry'))
        if image['local_tag'] != 'codex-agent-platform-' + component + ':' + version or not digest(image['id']) or not digest(image['config_id']):
            raise ImageError('Invalid official image identity')
        registry = image['registry']
        if registry is not None and (not isinstance(registry, str) or not re.fullmatch(re.escape(REGISTRY + component) + r'@sha256:[a-f0-9]{64}', registry)):
            raise ImageError('Invalid official image repository')
    return copy.deepcopy(value)


def labels_for(component, manifest):
    return {'org.opencontainers.image.source': SOURCE,
            'org.opencontainers.image.version': manifest['version'],
            'org.opencontainers.image.revision': manifest['revision'],
            'io.codex-agent-platform.component': component,
            'io.codex-agent-platform.distribution': 'official'}


def check_config(config, component, manifest):
    labels = config.get('config', {}).get('Labels')
    if (config.get('os') != 'linux' or config.get('architecture') != 'amd64' or not isinstance(labels, dict) or
            any(labels.get(k) != v for k, v in labels_for(component, manifest).items())):
        raise ImageError('Official image configuration does not match release')


def verify_archive(path, manifest):
    """Validate every imported tag/config before giving a trusted archive to Docker."""
    try:
        with tarfile.open(path, 'r:*') as tar:
            members = tar.getmembers()
            if len(members) > 20000 or sum(m.size for m in members) > 32 * 1024 ** 3:
                raise ImageError('Official image archive exceeds limits')
            names = {}
            for item in members:
                parts = PurePosixPath(item.name).parts
                if (not parts or item.name.startswith('/') or '..' in parts or '\\' in item.name or
                        not (item.isfile() or item.isdir()) or item.name in names):
                    raise ImageError('Unsafe official image archive member')
                names[item.name] = item
            def read(name, limit):
                item = names.get(name)
                if not item or not item.isfile() or item.size > limit:
                    raise ImageError('Missing or oversized image archive metadata')
                return tar.extractfile(item).read()
            entries = json_object(read('manifest.json', 256 * 1024))
            if not isinstance(entries, list) or len(entries) != len(COMPONENTS):
                raise ImageError('Official image archive has unexpected images')
            expected = {v['local_tag']: k for k, v in manifest['images'].items()}
            seen = set()
            for item in entries:
                tags = item.get('RepoTags') if isinstance(item, dict) else None
                if not isinstance(tags, list) or len(tags) != 1:
                    raise ImageError('Official archive contains unexpected image tags')
                tag = tags[0]
                if tag.startswith('docker.io/library/'):
                    tag = tag[len('docker.io/library/'):]
                if tag not in expected or tag in seen:
                    raise ImageError('Official archive contains unrelated or duplicate image tags')
                seen.add(tag)
                config = read(item.get('Config'), 2 * 1024 * 1024)
                component = expected[tag]
                config_id = 'sha256:' + hashlib.sha256(config).hexdigest()
                if config_id != manifest['images'][component]['config_id']:
                    raise ImageError('Official image configuration digest does not match')
                check_config(json_object(config), component, manifest)
                # Docker's containerd store identifies the OCI manifest/index, while
                # classic stores identify the config. Bind either identity to this config.
                def binds(image_id, depth=0):
                    if image_id == config_id: return True
                    if depth > 4 or not digest(image_id): return False
                    blob = read('blobs/sha256/' + image_id[7:], 2 * 1024 * 1024)
                    if 'sha256:' + hashlib.sha256(blob).hexdigest() != image_id: return False
                    value = json_object(blob)
                    if value.get('config', {}).get('digest') == config_id: return True
                    children = value.get('manifests', [])
                    if not isinstance(children, list) or len(children) > 32: return False
                    return any(binds(child.get('digest'), depth + 1) for child in children if isinstance(child, dict))
                if not binds(manifest['images'][component]['id']):
                    raise ImageError('Official image ID does not bind its configuration')
    except (tarfile.TarError, KeyError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise ImageError('Invalid official image archive metadata') from error


def run_command(args, capture=False, **kwargs):
    result = subprocess.run([str(x) for x in args], check=False, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, **kwargs)
    if result.returncode:
        error = ImageError('Official image command failed: ' + ' '.join(map(str, args[:2])))
        error.stderr = result.stderr or ''
        raise error
    return result.stdout or ''


def download_file(url, path, limit):
    run_command(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
                 '--proto-redir', '=https', '--connect-timeout', '20', '--max-time',
                 '3600' if limit > 64 * 1024 ** 2 else '300', '--max-filesize', str(limit),
                 '--output', path, url])
    if path.stat().st_size > limit:
        raise ImageError('Official image download exceeds limit')


def sha256_file(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def source_revision(source):
    source = Path(source).resolve()
    marker = source / '.release-revision'
    if marker.is_file() and not marker.is_symlink():
        value = marker.read_text().strip()
    else:
        top = Path(run_command(['git', '-C', source, 'rev-parse', '--show-toplevel'], capture=True).strip()).resolve()
        if top != source:
            raise ImageError('Cannot identify exact official release source')
        value = run_command(['git', '-C', source, 'rev-parse', 'HEAD'], capture=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', value):
        raise ImageError('Invalid official release source revision')
    return value


def checksums(body):
    result = {}
    for line in body.splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_.-]*)', line)
        if not match or match[2] in result:
            raise ImageError('Invalid official release checksums')
        result[match[2]] = match[1]
    return result


def inspect_images(manifest, run=run_command, *, imported=False):
    resolved = {}
    for component in COMPONENTS:
        item = manifest['images'][component]
        ref = item['local_tag'] if imported else item['registry'] or item['id']
        values = json_object(run(['docker', 'image', 'inspect', ref], capture=True))
        allowed = {item['id'], item['config_id']}
        if item['registry']: allowed.add(item['registry'].split('@')[1])
        if not isinstance(values, list) or len(values) != 1 or values[0].get('Id') not in allowed:
            raise ImageError('Loaded image identity differs from official release')
        info = values[0]
        check_config({'architecture': info.get('Architecture'), 'os': info.get('Os'),
                      'config': info.get('Config', {})}, component, manifest)
        resolved[component] = info['Id']
    return resolved


def prepare(source, data, version, *, run=run_command, download=download_file):
    source, data = Path(source), Path(data)
    if json_object((source / 'package.json').read_text()).get('version') != version:
        raise ImageError('Official images must match the deployment source version')
    revision = source_revision(source)
    host = run(['docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}'], capture=True).strip()
    if host not in ('linux/amd64', 'linux/x86_64'):
        raise ImageError('Official images support Linux amd64; select source build for this host')
    if not VERSION.fullmatch(version):
        raise ImageError('Invalid official release version')
    base = SOURCE + '/releases/download/v' + version + '/'
    with tempfile.TemporaryDirectory(prefix='platform-images-', dir=data) as temporary:
        directory = Path(temporary)
        checksum_path, manifest_path = directory / 'SHA256SUMS', directory / 'container-images.json'
        download(base + 'SHA256SUMS', checksum_path, 64 * 1024)
        sums = checksums(checksum_path.read_text())
        download(base + 'container-images.json', manifest_path, 256 * 1024)
        if sums.get('container-images.json') != sha256_file(manifest_path):
            raise ImageError('Official image manifest checksum does not match')
        manifest = validate_manifest(json_object(manifest_path.read_bytes()), version, revision)
        archive = manifest['archive']
        if sums.get(archive['name']) != archive['sha256']:
            raise ImageError('Official image archive checksum is not bound to release')
        registry = all(manifest['images'][c]['registry'] is not None for c in COMPONENTS)
        if registry:
            try:
                for component in COMPONENTS:
                    run(['docker', 'pull', manifest['images'][component]['registry']])
                resolved = inspect_images(manifest, run)
            except Exception:
                registry = False
                print('Official registry unavailable; using the verified release image archive.', flush=True)
        if not registry:
            path = directory / archive['name']
            download(base + archive['name'], path, MAX_ARCHIVE)
            if path.stat().st_size != archive['size'] or sha256_file(path) != archive['sha256']:
                raise ImageError('Official image archive checksum or size does not match')
            verify_archive(path, manifest)
            run(['docker', 'load', '--input', str(path)])
            resolved = inspect_images(manifest, run, imported=True)
        # Keep existing Compose/discovery and old updater identity checks compatible.
        for component in COMPONENTS:
            image = manifest['images'][component]
            run(['docker', 'tag', resolved[component], image['local_tag']])
        return manifest


def cleanup(*, apply=False, run=run_command):
    """Remove only old fixed-project version tags; never force or prune shared Docker state."""
    rows = [json_object(line) for line in run(['docker', 'image', 'ls', '--no-trunc', '--format', '{{json .}}'], capture=True).splitlines() if line.strip()]
    ids = run(['docker', 'ps', '--all', '--quiet', '--no-trunc'], capture=True).split()
    protected = set()
    if ids:
        for offset in range(0, len(ids), 100):
            containers = json_object(run(['docker', 'container', 'inspect', *ids[offset:offset + 100]], capture=True))
            if not isinstance(containers, list) or any(not digest(item.get('Image')) for item in containers):
                raise ImageError('Cannot identify container images; cleanup cancelled')
            protected.update(item['Image'] for item in containers)
    repositories = {'codex-agent-platform-' + c for c in COMPONENTS} | {REGISTRY + c for c in COMPONENTS}
    selected = [item for item in rows if item.get('Repository') in repositories and isinstance(item.get('Tag'), str) and VERSION.fullmatch(item['Tag'])]
    versions = sorted({item['Tag'] for item in selected}, key=lambda v: tuple(map(int, v.split('.'))), reverse=True)
    keep = set(versions[:3])
    candidates = sorted({item['Repository'] + ':' + item['Tag'] for item in selected if item['Tag'] not in keep and item.get('ID') not in protected and digest(item.get('ID'))})
    if apply:
        for tag in candidates:
            run(['docker', 'image', 'rm', tag])
    return candidates
