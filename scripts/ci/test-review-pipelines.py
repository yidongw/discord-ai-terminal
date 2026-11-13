#!/usr/bin/env python3
"""Stress the actual first-result selectors under the workflow's Bash pipefail mode."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / "scripts/ci"
failures = []
with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    # API selectors must retain the first result while draining large producer output.
    (work / "ids").write_text("7\n" + "8\n" * 200000)
    (work / "jobs").write_text('{"jobs":[' + ','.join(
        '{"name":"review","id":%d}' % i for i in range(1000, 21000)) + ']}')
    label = "failure " + "x" * 4096
    (work / "bun-test.txt").write_text((label + "\n") * 1000)
    (work / "groups").write_text("sudo " + "unprivileged " * 100000 + "\n")
    workflow = (ROOT / ".github/workflows/review.yml").read_text().splitlines()
    cases = []
    for line in (CI / "review-passed.sh").read_text().splitlines():
        if line.strip().startswith('art=$(gh api '):
            cases.append((f"artifact selector {len(cases) + 1}", line, "art", "7"))
    assert len(cases) == 2, "approval artifact selectors changed; update the fixture"
    line = next(line for line in (CI / "prior-findings.sh").read_text().splitlines()
                if line.strip().startswith('jid=$(api '))
    cases.append(("ledger job selector", line, "jid", "1000"))
    line = next(line for line in workflow if line.strip().startswith('n=$(grep '))
    cases.append(("test failure diagnostic selector", line, "n", "1"))
    group_guard = next(line for line in workflow if line.strip().startswith('if id -nG |'))
    setup = '''
gh() { cat "$FIXTURE_DIR/ids"; }
api() { cat "$FIXTURE_DIR/jobs"; }
id() { cat "$FIXTURE_DIR/groups"; }
repo=o/r; id=1; rid=1
'''
    env = dict(os.environ, FIXTURE_DIR=str(work), RUNNER_TEMP=str(work), l=label)
    for name, line, variable, want in cases:
        script = setup + line.strip() + f'\n[ "${{{variable}}}" = "{want}" ]\n'
        result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script, "fixture", "1"],
                                env=env, text=True, capture_output=True)
        if result.returncode:
            failures.append(f"{name}: exit {result.returncode}; {result.stderr.strip()}")
        else:
            print(f"ok: {name} consumes large output and selects the first result")
    result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", setup + group_guard],
                            env=env, text=True, capture_output=True)
    if result.returncode != 1 or '::error::test user in a privileged group' not in result.stdout:
        failures.append(f"privileged group guard: expected rejection, exit {result.returncode}")
    else:
        print("ok: privileged group guard rejects a match early in large output")
if failures:
    raise SystemExit("\n".join("FAIL: " + failure for failure in failures))
