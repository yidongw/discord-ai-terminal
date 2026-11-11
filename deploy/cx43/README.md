# cx43 host files (reference copies)

`deploy-checkout.conf` is the drop-in installed at
`/etc/systemd/system/discord-ai-terminal.service.d/deploy-checkout.conf` on cx43. It makes the system unit
`discord-ai-terminal.service` run the release the autodeploy controller manages
(`/home/ubuntu/deploy/discord-ai-terminal/current`) instead of the clone agents develop in. The unit's
WorkingDirectory (`/home/ubuntu/git/discord-ai-terminal`: `.env`, `sessions.db`, `runs/`, `jobs/`) is unchanged.
The controller is `~/bin/discord-ai-terminal-autodeploy` on cx43 (see CLAUDE.md "Shipping").
