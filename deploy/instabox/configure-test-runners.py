#!/usr/bin/env python3
"""Install per-listener workspaces and job-scoped cleanup while both runners are stopped."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

RUNNERS = (
    ('discord-ai-terminal-r1', 'instabox-discord-ai-terminal', 'discord-ai-terminal-work'),
    ('discord-ai-terminal-r2', 'instabox-discord-ai-terminal-main', 'discord-ai-terminal-main-work'),
)


def atomic_write(path, content, uid, gid, mode):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(content)
            os.fchmod(f.fileno(), mode)
            os.fchown(f.fileno(), uid, gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure(root=Path('/')):
    template = Path(__file__).with_name('job-completed.sh').read_text()
    ci_root = root / 'data/discord-ai-terminal-work/ci'
    plans = []
    # Validate every listener before changing either one. A stopped unit cannot
    # accept a new job between a Worker check and a configuration write.
    for directory, agent, folder in RUNNERS:
        runner = root / 'srv' / directory
        service = (runner / '.service').read_text().strip()
        expected = f'actions.runner.yidongw-discord-ai-terminal.{agent}.service'
        if service != expected:
            raise RuntimeError(f'unexpected service at {runner}')
        state = subprocess.check_output(
            ['systemctl', 'show', service, '--property=ActiveState', '--value'], text=True
        ).strip()
        if state != 'inactive':
            raise RuntimeError(f'stop {service} and let its job finish first (state: {state})')
        config_path = runner / '.runner'
        config = json.loads(config_path.read_text(encoding='utf-8-sig'))
        if config['agentName'] != agent:
            raise RuntimeError(f'unexpected runner at {runner}')
        work = root / 'data' / folder
        old_work = root / 'data/discord-ai-terminal-work'
        if config['workFolder'] not in (str(old_work), str(work)):
            raise RuntimeError(f'unexpected workFolder at {runner}')
        config['workFolder'] = str(work)
        stat = config_path.stat()
        plans.append((runner, config_path, config, stat, work))
    for runner, config_path, config, stat, work in plans:
        work.mkdir(parents=True, exist_ok=True)
        os.chown(work, stat.st_uid, stat.st_gid)
        os.chmod(work, 0o755)
        hook = template.replace('@WORK_ROOT@', shlex.quote(str(work))).replace(
            '@CI_ROOT@', shlex.quote(str(ci_root)))
        atomic_write(runner / 'job-completed.sh', hook, 0, 0, 0o755)
        atomic_write(config_path, json.dumps(config, indent=2) + '\n',
                     stat.st_uid, stat.st_gid, stat.st_mode & 0o777)
        print(f'{config["agentName"]}: {work}')


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('run as root on the InstaBox test VM, with both runner services stopped')
    configure()
