"""Private maintenance archive; no pickle, shell, links or extractall."""
import os
import re
import sys
import tarfile
from pathlib import Path

MAX_BYTES = 256 * 1024**3
MAX_FILES = 100_002

def allowed(name):
    return name in ('manifest.json', 'storyflow.sqlite') or re.fullmatch(r'files/[a-f0-9]{64}', name)

def main():
    mode, archive, directory = sys.argv[1:]
    root = Path(directory).resolve()
    if mode == 'pack':
        with tarfile.open(archive, 'x') as out:
            for file in [root / 'manifest.json', root / 'storyflow.sqlite', *sorted((root / 'files').iterdir())]:
                name = file.relative_to(root).as_posix()
                if not allowed(name) or file.is_symlink() or not file.is_file():
                    raise ValueError('Unsupported backup entry')
                info = out.gettarinfo(str(file), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mode = 0o600
                with file.open('rb') as stream:
                    out.addfile(info, stream)
    elif mode == 'unpack':
        total = 0
        seen = set()
        with tarfile.open(archive, 'r:*') as source:
            for member in source:
                name = member.name
                if not member.isfile() or not allowed(name) or name in seen:
                    raise ValueError('Unsafe or duplicate archive entry')
                total += member.size
                seen.add(name)
                if len(seen) > MAX_FILES or total > MAX_BYTES or member.size > 8 * 1024**3:
                    raise ValueError('Archive exceeds maintenance limits')
                if name == 'manifest.json' and member.size > 64 * 1024**2:
                    raise ValueError('Manifest exceeds limit')
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError('Unreadable entry')
                with os.fdopen(fd, 'wb') as target, stream:
                    remaining = member.size
                    while remaining:
                        block = stream.read(min(1024**2, remaining))
                        if not block:
                            raise ValueError('Truncated archive')
                        target.write(block)
                        remaining -= len(block)
        if not {'manifest.json', 'storyflow.sqlite'} <= seen:
            raise ValueError('Incomplete backup')
    else:
        raise ValueError('Unknown archive operation')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Archive rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
