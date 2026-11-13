#!/usr/bin/env python3
"""Reproduce deployed shared-workspace cleanup; verify the host migration without root."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / 'deploy/instabox/configure-test-runners.py'
# Snapshot of the deployed 2026-11-13 completion hook, with only paths rebased
# into the fixture. Both listeners originally used this same workFolder.
LEGACY = '''#!/usr/bin/env bash
for u in $(getent passwd | cut -d: -f1 | grep -E '^datci[0-9]+$'); do
  sudo -n pkill -KILL -u "$u" 2>/dev/null; sleep 1; sudo -n userdel "$u" 2>/dev/null
done
sudo -n rm -rf @OLD@/ci 2>/dev/null
rm -rf @OLD@/discord-ai-terminal @OLD@/_temp 2>/dev/null
exit 0
'''


class Workspaces(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runner-workspaces-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'data/discord-ai-terminal-work'
        self.old.mkdir(parents=True)
        self.runners = []
        self.originals = []
        for suffix, agent in [('r1', 'instabox-discord-ai-terminal'),
                              ('r2', 'instabox-discord-ai-terminal-main')]:
            r = self.root / f'srv/discord-ai-terminal-{suffix}'
            r.mkdir(parents=True)
            config = dict(agentName=agent, workFolder=str(self.old), agentId=42,
                          serverUrl='https://github.com/yidongw/discord-ai-terminal')
            (r / '.runner').write_text('\ufeff' + json.dumps(config))
            (r / '.runner').chmod(0o600)
            (r / '.service').write_text(f'actions.runner.yidongw-discord-ai-terminal.{agent}.service\n')
            (r / 'job-completed.sh').write_text(LEGACY.replace('@OLD@', str(self.old)))
            self.runners.append(r)
            self.originals.append(config)
        self.module = None
        # With the fix checked out, leave the deployed snapshot intact. This
        # makes the before run exercise the deletion race, not a missing import.
        if INSTALLER.exists() and INSTALLER.read_text().strip():
            spec = importlib.util.spec_from_file_location('configure_runners', INSTALLER)
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
            self.configure()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'users.log'
        scripts = {
            'sudo': '''#!/usr/bin/env bash
[ "$1" = -n ] && shift
case "$1" in
  pkill|userdel) printf '%s\\n' "$*" >> "$USER_LOG" ;;
  rm) exec /usr/bin/rm "${@:2}" ;;
  *) exit 90 ;;
esac
''',
            'getent': '''#!/usr/bin/env bash
if [ $# = 2 ]; then
  printf '%s:x:1001:1001::/unused:/usr/sbin/nologin\\n' datci101 datci202
else
  printf '%s:x:1001:1001::/unused:/usr/sbin/nologin\\n' "$2"
fi
''',
            'sleep': '#!/usr/bin/env bash\nexit 0\n',
        }
        for name, script in scripts.items():
            p = self.bin / name
            p.write_text(script)
            p.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', USER_LOG=str(self.log))

    def configure(self, state='inactive'):
        # Keep real file writes/permissions, fake only privileged ownership and
        # service discovery. No service, real account or process is touched.
        fake_os = types.SimpleNamespace(**{k: getattr(os, k) for k in dir(os)})
        fake_os.fchown = lambda *args: None
        fake_os.chown = lambda *args: None
        with patch.object(self.module, 'os', fake_os), patch.object(
            self.module.subprocess, 'check_output', return_value=state + '\n'
        ):
            with contextlib.redirect_stdout(io.StringIO()):
                self.module.configure(self.root)

    def work(self, n):
        return Path(json.loads((self.runners[n] / '.runner').read_text(encoding='utf-8-sig'))['workFolder'])

    def prepare(self, n):
        work = self.work(n)
        workspace = work / 'discord-ai-terminal/discord-ai-terminal'
        workspace.mkdir(parents=True, exist_ok=True)
        for relative in ['_temp/job.sh', '_actions/action/index.js', '_PipelineMapping/mapping.json']:
            path = work / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('prepared')
        return workspace

    def cleanup(self, n, run_id='101'):
        workspace = self.prepare(n)
        return subprocess.run(
            ['bash', str(self.runners[n] / 'job-completed.sh')], cwd=workspace,
            env=dict(self.env, GITHUB_RUN_ID=run_id, GITHUB_WORKSPACE=str(workspace),
                     RUNNER_TEMP=str(self.work(n) / '_temp')), capture_output=True, text=True
        )

    def test_completion_cannot_remove_other_listeners_prepared_workspace(self):
        # Prepare B before A completes, just as Runner.Worker does before the
        # admission hook/VM lock. Repeat with the roles reversed.
        for current, queued in [(0, 1), (1, 0)]:
            with self.subTest(completing=current):
                self.prepare(current)
                queued_workspace = self.prepare(queued)
                result = self.cleanup(current)
                self.assertEqual(result.returncode, 0, result.stderr)
                # This is the reported failure: launching Bash with B's cwd.
                try:
                    subprocess.run(['/usr/bin/bash', '-c', 'true'], cwd=queued_workspace, check=True)
                except FileNotFoundError:
                    self.fail(f'completion deleted the other runner cwd: {queued_workspace}')
                for relative in ['_temp/job.sh', '_actions/action/index.js', '_PipelineMapping/mapping.json']:
                    self.assertTrue((self.work(queued) / relative).exists(), relative)
                self.assertFalse((self.work(current) / 'discord-ai-terminal').exists())
                self.assertFalse((self.work(current) / '_temp').exists())

    def test_setup_failure_only_cleans_its_own_user_and_staging_copy(self):
        ci = self.old / 'ci'
        for run_id in ['101', '202']:
            (ci / f'datci{run_id}').mkdir(parents=True)
            (ci / f'datci{run_id}/candidate').write_text('keep other run')
        result = self.cleanup(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((ci / 'datci202/candidate').exists(), 'other run staging copy deleted')
        self.assertFalse((ci / 'datci101').exists())
        self.assertEqual(self.log.read_text().splitlines(), ['pkill -KILL -u datci101', 'userdel datci101'])

    def test_invalid_run_id_cannot_trigger_cleanup(self):
        queued = self.prepare(1)
        self.assertNotEqual(self.cleanup(0, '../202').returncode, 0)
        self.assertTrue(queued.exists())
        self.assertFalse(self.log.exists())

    def test_registration_preserved_and_configuration_idempotent(self):
        if self.module is None:
            self.skipTest('no host configurator in the before revision')
        before = [(r / '.runner').read_bytes() for r in self.runners]
        self.configure()
        for n, r in enumerate(self.runners):
            config = json.loads((r / '.runner').read_text())
            original = self.originals[n]
            self.assertEqual({k: v for k, v in config.items() if k != 'workFolder'},
                             {k: v for k, v in original.items() if k != 'workFolder'})
            self.assertEqual((r / '.runner').read_bytes(), before[n])
            self.assertEqual((r / '.runner').stat().st_mode & 0o777, 0o600)
            self.assertEqual((r / 'job-completed.sh').stat().st_mode & 0o777, 0o755)
        self.assertNotEqual(self.work(0), self.work(1))

    def test_active_listener_refused_before_any_write(self):
        if self.module is None:
            self.skipTest('no host configurator in the before revision')
        before = [(r / '.runner').read_bytes() for r in self.runners]
        with self.assertRaisesRegex(RuntimeError, 'let its job finish'):
            self.configure('active')
        self.assertEqual([(r / '.runner').read_bytes() for r in self.runners], before)


if __name__ == '__main__':
    unittest.main()
