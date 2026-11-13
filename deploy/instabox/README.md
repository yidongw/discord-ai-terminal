# InstaBox test runner configuration

The two listeners must have separate `workFolder` values. The runner prepares
its workspace and downloads actions **before** the job-started hook takes the
VM-wide suite lock. Sharing a work folder lets one completion hook delete the
other listener's working directory before Bash can start (#0, run 43379232984).

`configure-test-runners.py` keeps r1 at `/data/discord-ai-terminal-work` and moves
r2 to `/data/discord-ai-terminal-main-work`. It also installs the root-owned
`job-completed.sh` for both: clean only the current run's `datci<run id>` user
and staging directory, then that listener's checkout and temporary files.
The workflow's per-job copies remain under `/data/discord-ai-terminal-work/ci`;
these have distinct run ids. Admission guards, labels and the VM suite lock stay
in place. Never put this configuration step inside candidate CI code.

Copy these two source files to the InstaBox VM. Wait for both listeners to be
idle, then stop only their units (do not interrupt active jobs):

```sh
sudo systemctl stop actions.runner.yidongw-discord-ai-terminal.instabox-discord-ai-terminal.service actions.runner.yidongw-discord-ai-terminal.instabox-discord-ai-terminal-main.service
sudo python3 configure-test-runners.py
sudo systemctl start actions.runner.yidongw-discord-ai-terminal.instabox-discord-ai-terminal.service actions.runner.yidongw-discord-ai-terminal.instabox-discord-ai-terminal-main.service
```

The installer refuses any unit that has not fully stopped. It preserves runner
registration and config ownership/mode and can be rerun. Do not copy old actions,
workspaces or dependency installations into the new folder. No CI rerun can
repair a missing working directory before the admission hook; install the host
configuration before relying on the next pushed commit's trusted tests.

Offline regression (Python standard library only, no sudo or service changes):

```sh
python3 scripts/ci/test-runner-workspaces.py
```
