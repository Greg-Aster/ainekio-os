# Headless Runtime Mode

Headless mode is a machine-wide startup flag. When set, `mh start` skips
boot-managed agents. The maintained web control and `/api/runtime/mode` route
persist this state and write an audit event. Changing the flag does not stop or
restart running agents.

## What the control does

An owner can change the mode under **System → Network**. The routed handler
writes `etc/runtime.json` through Core's runtime-mode owner and reports the new
state. Clear the flag before a subsequent system start to include configured
boot-managed agents. The banner links to this same control; it does not claim
resources or restart agents.

The current maintained UI/API path does not:

- stop Agent Monitor processes when headless mode is entered;
- restart `startOnSystemBoot` services when active mode is restored;
- stop the web server, tunnel, inference backend, or voice services; or
- prove that resources were reclaimed.

## State

The machine-wide state has this shape:

```json
{
  "headless": false,
  "lastChangedBy": "local",
  "changedAt": "2026-08-24T00:00:00.000Z",
  "claimedBy": null
}
```

- `headless` is the recorded mode.
- `lastChangedBy` is `local` or `remote`.
- `changedAt` is the last transition time.
- `claimedBy` identifies the remote claimant when applicable.

Use the supported UI or runtime-mode API instead of editing the file directly.
There is no supported `HEADLESS_RUNTIME` environment variable.

## Operating an unattended installation

Treat service lifecycle as a separate operation. Inspect **Agent Monitor** or:

```bash
./bin/mh agent ps
```

Stop or start the intended services through their canonical controls. Verify the
web, tunnel, model, voice, and environment owners independently when they are
part of the deployment.

Headless state is not authentication and does not expose the site. Use
[Deployment and Remote Access](/user-guide#deployment) for the supported tunnel
path and review [Security & Trust](/user-guide#security-trust) before exposing
an instance.

## Verification

Verify separate claims with separate evidence:

- `etc/runtime.json` or the UI confirms only the recorded mode;
- Agent Monitor or `./bin/mh agent ps` confirms managed-process state;
- service-specific status checks confirm inference and voice availability;
- an authenticated request to the configured URL confirms web or tunnel reachability.

Do not interpret the headless banner or state file as proof that any process was
stopped, started, or reached externally.
