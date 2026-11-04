# Running MetaHuman OS

The maintained runtime is Linux-first. Install dependencies and build the Site
before starting it:

```bash
pnpm install
pnpm build
```

## Production

```bash
./start.sh
```

`start.sh` is the canonical startup owner. It validates Node, starts configured
background services, and runs the prebuilt web server in the foreground. It
never installs packages or builds source. Background launchers run concurrently;
dispatch does not mean readiness. The application starts while its dispatcher
owns the unfinished launch commands. Failed launchers print their exit code and
log path in the terminal. Details remain in `logs/run/<service>.launcher.log`.
Stopping the application cancels unfinished startup commands before stopping
their services, so a late launch cannot recreate a stopped service.

Assigned model endpoints start through Core after authentication selects an
unlocked, available profile, including restoration of a surviving browser
session. Unauthenticated boot does not select a default profile or load models.

Normal Ctrl+C delegates service shutdown to `stop.sh --services-only`, including
on-demand agents and terminal sessions. Use `--app-only` below when another
lifecycle owns the services. Full `./stop.sh` first asks the launcher to stop only
its application and unfinished startup commands, then dispatches service stops
once. The internal `USR2` signal selects that existing application-only cleanup.
The full command also removes the optional PM2 registration. Each service releases
its own processes and state; the scripts do not
rewrite agent registries or scan for service names to kill. Failed owners are
reported, remaining shutdown steps run, and full shutdown returns a failure code.

Text, vision, motion and embeddings use the shared native llama.cpp host described
in the [software architecture](docs/robot/SYSTEM_ARCHITECTURE.md#shared-llamacpp-hosting).
Model Registry/Router select models; native presets own model loading, CPU/GPU
placement and capacity. The Embedder role uses that same service. Application
shutdown leaves its independent systemd unit running. The old Node embedding
service, process manager and local-model start/stop controls are removed.
Shared voice boot selection remains in `etc/voice-servers.json`.

Event-bus shell and API controls share the process lifecycle in Core's existing
event-bus server module and `logs/run/event-bus.pid`. Stop terminates the recorded
process and its client connections; it does not kill arbitrary port listeners.

After building an update, replace only the running web application with:

```bash
./start.sh --restart-app
```

The existing launcher verifies the build and replaces its web child. Background
services, including model training and inference services, remain unchanged.
This requires a launcher started with the current script. It reports the restart
request; the launcher log records verification and the new server startup.

To start just the application while another lifecycle owns the services:

```bash
./start.sh --app-only
```

This mode neither starts background services nor stops them when it exits.
Normal `./start.sh` and full `./stop.sh` retain their service lifecycle behavior.

## Development

```bash
pnpm --dir apps/site dev
```

The development command runs only the Site dev server. Start optional background
services separately with `./bin/start-services --background` when needed.

## Background operation

Install PM2 explicitly, then run:

```bash
./bin/start-pm2
./bin/stop-pm2
```

PM2 supervises the same canonical `start.sh` path as one forked instance. It
does not maintain a second service launcher or cluster multiple web runtimes.

The maintained mobile shell is `apps/react-native`; its build and release
commands are documented in that package.
