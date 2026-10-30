"""Bounded no-follow file operations, executed inside the private code container."""
import base64
import binascii
import hashlib
import json
import os
import stat
import sys


class FileError(ValueError):
    pass


def _parts(path, allow_root=False):
    if path in (None, '', '.') and allow_root:
        return []
    if not isinstance(path, str) or len(path) > 1024 or '\x00' in path:
        raise FileError('Invalid workspace path')
    if path.startswith('/workspace/'):
        path = path[len('/workspace/'):]
    parts = path.split('/')
    try:
        invalid = any(p in ('', '.', '..') or len(p.encode()) > 255 for p in parts)
    except UnicodeError:
        raise FileError('Path must contain valid Unicode') from None
    if invalid:
        raise FileError('Path must remain inside the workspace')
    return parts


def _directory(root, parts, create=False):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise FileError('Only ordinary files without links are supported')
    return info


def _integer(value, default, maximum):
    value = default if value is None else value
    if type(value) is not int or value < 0 or value > maximum:
        raise FileError('Invalid byte range')
    return value


def operate(root, args):
    action = args.get('action')
    parts = _parts(args.get('path'), action == 'list')
    try:
        if action == 'list':
            fd = _directory(root, parts)
            try:
                names = sorted(os.listdir(fd))
                result = []
                for name in names[:200]:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 else 'unsupported'
                    result.append({'name': name, 'type': kind, 'size': info.st_size})
                return {'entries': result, 'truncated': len(names) > 200}
            finally:
                os.close(fd)
        if action not in ('read', 'write', 'import', 'delete', 'export'):
            raise FileError('Unknown file action')
        parent = _directory(root, parts[:-1], action in ('write', 'import'))
        try:
            name = parts[-1]
            if action in ('write', 'import'):
                if action == 'write':
                    text = args.get('text')
                    if not isinstance(text, str):
                        raise FileError('Text is required')
                    data = text.encode('utf-8')
                    if len(data) > 256 * 1024:
                        raise FileError('Text exceeds 256 KiB')
                else:
                    encoded = args.get('content_base64')
                    if not isinstance(encoded, str) or len(encoded) > 27962028:
                        raise FileError('Import exceeds 20 MiB')
                    try:
                        data = base64.b64decode(encoded, validate=True)
                    except (ValueError, binascii.Error):
                        raise FileError('Invalid base64 content') from None
                    if len(data) > 20 * 1024 * 1024:
                        raise FileError('Import exceeds 20 MiB')
                # Validate any existing target before replacement; never truncate through a link.
                try:
                    existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                except FileNotFoundError:
                    existing = None
                if existing is not None:
                    try:
                        _regular(existing)
                        expected = args.get('expected_hash')
                        if expected is not None:
                            with os.fdopen(os.dup(existing), 'rb') as file:
                                if hashlib.sha256(file.read(20 * 1024 * 1024 + 1)).hexdigest() != expected:
                                    raise FileError('File revision changed')
                    finally:
                        os.close(existing)
                temp = '.write-' + os.urandom(16).hex()
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    with os.fdopen(fd, 'wb') as file:
                        file.write(data)
                        file.flush()
                    os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                finally:
                    try:
                        os.unlink(temp, dir_fd=parent)
                    except FileNotFoundError:
                        pass
                return {'path': '/'.join(parts), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = _regular(fd)
                if action == 'delete':
                    os.unlink(name, dir_fd=parent)
                    return {'deleted': True, 'path': '/'.join(parts)}
                if action == 'export':
                    if info.st_size > 20 * 1024 * 1024:
                        raise FileError('Export exceeds 20 MiB')
                    with os.fdopen(os.dup(fd), 'rb') as file:
                        data = file.read(20 * 1024 * 1024 + 1)
                    if len(data) > 20 * 1024 * 1024:
                        raise FileError('Export exceeds 20 MiB')
                    return {'name': name, 'size': len(data), 'content_base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}
                offset = _integer(args.get('offset'), 0, 2**53 - 1)
                limit = _integer(args.get('limit'), 65536, 65536)
                os.lseek(fd, offset, os.SEEK_SET)
                data = os.read(fd, limit)
                digest = None
                if info.st_size <= 20 * 1024 * 1024:
                    os.lseek(fd, 0, os.SEEK_SET)
                    with os.fdopen(os.dup(fd), 'rb') as file:
                        digest = hashlib.sha256(file.read(20 * 1024 * 1024 + 1)).hexdigest()
                return {'sha256': digest, 'path': '/'.join(parts), 'size': info.st_size, 'offset': offset, 'text': data.decode('utf-8', errors='replace'), 'content_base64': base64.b64encode(data).decode(), 'truncated': offset + len(data) < info.st_size}
            finally:
                os.close(fd)
        finally:
            os.close(parent)
    except (OSError, UnicodeError, IndexError) as error:
        raise FileError('Workspace path is missing, unsafe or unavailable') from error


if __name__ == '__main__':
    try:
        print(json.dumps(operate('/workspace', json.load(sys.stdin))))
    except (FileError, ValueError) as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(2)
