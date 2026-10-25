# Advanced mode: departments

Basic liaison is one coordinator session in the office folder. Advanced mode adds **departments**: long-lived peers that each run in their own tmux session, in their own folder, with their own Slack channel and their own identity.

## What a department is

A department is four things:

- a folder (by default `.liaison/departments/<name>/`),
- an `AGENT.md` in that folder: mission, roles, KPIs, inputs and outputs, autonomy level (L1 to L4), first tasks, status,
- a `START.md`: the one paragraph typed into the session when it starts,
- a Slack channel (`liaison-<name>` by default), registered with the bridge so the session hears that channel.

The session runs in tmux under the name `liaison-<name>`, started with the same engine command as the coordinator.

## Turn it on

```
liaison advanced enable
```

This writes `.liaison/roster.json` (if missing) with one example department, `engineering`, creates its folder with `AGENT.md` and `START.md`, registers the folder and channel with the bridge, and sets `advanced` to `true` in the config. Running it again changes nothing that already exists. It does not start any session and does not install any schedule.

```
liaison advanced run
```

One supervisor pass. For each enabled department it prints one line:

- `<name>: running` the tmux session already exists, nothing was touched,
- `<name>: started` the session was created and the start prompt typed in,
- `<name>: disabled` the roster entry has `"enabled": false`,
- `<name>: error: dir missing` the folder does not exist (the pass continues and exits 1 at the end).

It never kills anything. Run it as often as you like.

## Add a department

1. Add an entry to `.liaison/roster.json`:

   ```json
   {
     "name": "marketing",
     "enabled": true,
     "dir": "departments/marketing",
     "channel": "liaison-marketing",
     "effort": "medium",
     "start_prompt_file": "departments/marketing/START.md"
   }
   ```

   `name` is lowercase letters and digits joined by single hyphens. Relative `dir` and `start_prompt_file` are resolved against the folder that holds `roster.json`; absolute paths work too. `effort` is passed to the engine.
2. Run `liaison advanced enable`. It creates the folder, `AGENT.md` and `START.md` from the templates (existing files are never overwritten) and registers the folder with Slack.
3. Edit `AGENT.md` and `START.md` to describe the work.
4. Run `liaison advanced run`.

## How departments talk to each other

Through Slack channels and files, never through each other's terminals. Post in the other department's channel, or leave a file in a shared folder that both read. Do not use `tmux send-keys` against another department's session: the owner's view of what happened lives in Slack and in the files.

## Keep it alive: scheduling

`enable` does not install a schedule. Pick one:

**cron** (any system), every 15 minutes:

```
*/15 * * * * /path/to/liaison/bin/liaison advanced run
```

**launchd** (macOS): save as `~/Library/LaunchAgents/com.liaison.advanced.plist` with the real path, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.liaison.advanced.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.liaison.advanced</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/liaison/bin/liaison</string>
    <string>advanced</string>
    <string>run</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
```

**systemd timer** (Linux): two files in `~/.config/systemd/user/`, then `systemctl --user enable --now liaison-advanced.timer`:

```
# liaison-advanced.service
[Service]
Type=oneshot
ExecStart=/path/to/liaison/bin/liaison advanced run

# liaison-advanced.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
```

**manual**: run `liaison advanced run` yourself whenever you want.

Schedulers run with a small environment: make sure `tmux`, `claude` and `python3` are on the `PATH` they use.

## Stop everything

1. Remove the schedule you installed (delete the cron line, `launchctl bootout gui/$(id -u) <plist>`, or `systemctl --user disable --now liaison-advanced.timer`).
2. Run `liaison advanced disable`. It kills the tmux session `liaison-<name>` of every roster entry (errors are ignored) and sets `advanced` to `false`. Folders, `AGENT.md` files and the roster stay.

To stop one department only: `tmux kill-session -t liaison-<name>` and set `"enabled": false` in the roster so the supervisor does not bring it back.
