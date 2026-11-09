# Dashboard and Monitoring

The web interface separates user status, work admission, process activity, and service health. Use the surface that owns the question you are trying to answer instead of treating one green indicator as proof that an entire workflow succeeded.

## Dashboard Tabs

Select **Dashboard** in the left sidebar. The center view provides these tabs:

- **Overview** — identity, trust, task counts, voice status, system health, memory index status, recent activity, and configured model roles.
- **Tasks** — the task-management view.
- **Sleep** — sleep-cycle status and controls.
- **Agent Catalog** — installed finite agents and persistent services, their source health, and their supported controls.
- **Trigger Manager** — configured schedules and event triggers.

Some tabs and actions are owner-only. Desire approvals and Active Operator controls
are in Agency; Chat also displays pending Desire approvals.

## Overview

The Overview displays the shared portal status snapshot. Application focus and
mode or model changes refresh that snapshot; **Refresh snapshot** requests a new
read through the same owner. Voice status is checked on entry, profile changes,
foreground focus and explicit refresh. The displayed times identify these reads;
they do not certify continuous service availability. Trigger Manager retains its
existing live stream. Sections include:

- active profile identity, role, trust level, and cognitive mode;
- active, in-progress, and blocked task counts;
- selected TTS provider and collected voice samples;
- selected model backend and its reported availability, plus audit-log size;
- memory file and semantic-index status;
- a link to Agent Catalog for current agent state and run history;
- profile values, goals, recent activity, and model-role assignments.

Values are omitted when their backing status endpoint has no data. A displayed process or provider state is not proof of an external effect such as audible speech, a connected robot, or a completed remote action.

## Right Sidebar

The right sidebar has three operational views:

- **Queue** shows active admitted work and unfinished workflows through the shared Coordinator stream. Connection state and any read errors appear separately; after a disconnect, the last received snapshot remains labeled until updates resume.
- **Agent Monitor** is owner-only and controls or inspects supported agent and service lifecycles.
- **Server Status** reports maintained shared services such as voice servers.

Use Queue for a finite job, Agent Monitor for agent or persistent-service activity, and Server Status for shared server readiness. They answer different questions.

## Tasks and Projects

Task Manager reads task history on entry and every 10 seconds while open; Project Dashboard reads projects and dependency views every 30 seconds. These existing polling intervals are retained because the task/project persistence owner has no complete change-event feed. Reads remain concurrent, older responses cannot replace newer published results, and closing either view ends polling and read publication. Read errors preserve known data and remain separate from write errors; unavailable Project data displays a dash rather than a zero count. Task search updates both list and calendar. Saving a task or creating a task/project preserves any newer draft entered while the submitted write finishes.

## Sleep

Sleep reads runtime status and recent session history on entry and every 10 seconds while the view is open. Configured stages are distinguished from recorded execution state. Read failures remain visible; any retained status is labeled with its reported time. Leaving the view releases polling and cached status. **Run sleep now** queues the existing Sleep Workflow; admission alone does not establish that a session has started.

## Agent Catalog and Trigger Manager

The **Agent Catalog** is the current inventory and manual-control surface. It distinguishes finite agents from persistent services and shows whether an installed agent is registered with Trigger Manager.

The **Trigger Manager** owns schedules and event-driven admission. Registering or enabling a trigger does not mean work is currently running; it means eligible events may submit work. A manual **Run now** action submits through the same managed execution path.

## Interpreting Status Correctly

Follow the chain appropriate to the feature:

1. **Configured** — the feature has valid settings.
2. **Available** — its provider or service is reachable.
3. **Admitted** — work appears in Queue or its coordinator.
4. **Running** — an owner reports active execution.
5. **Terminal** — the work finished or failed.
6. **Semantically complete** — the requested result was actually produced.
7. **Externally or physically confirmed** — a remote system, browser, or device shows the effect.

Do not infer later stages from an earlier one.

## CLI Checks

Run commands from the repository root:

```bash
./bin/mh status
./bin/mh backend status
./bin/mh agent list
./bin/mh agent status
./bin/mh voice-server status --all
```

`mh status` is a system summary. The more specific commands are better for isolating model, agent, or voice-service problems.

## Common Problems

### Dashboard says to initialize

Run:

```bash
./bin/mh init
```

Then restart through the normal start path and reload the page.

### Data looks old

Check the displayed connection state, errors and reported times. Queue updates through its existing stream; Sleep reads every 10 seconds while open; Overview has an explicit **Refresh snapshot** action. If views disagree, use the feature's canonical owner and recent execution record rather than the summary card.

### A service is running but the feature fails

Check the next boundary. For example, a running Whisper service still requires browser microphone permission and valid audio; a running TTS service still requires queue delivery and browser playback.

## Related Guides

- [Autonomous Agents](/user-guide#autonomous-agents)
- [Agent Catalog and Trigger Manager](/user-guide#autonomous-agents)
- [Voice Features](/user-guide#voice-features)
- [Troubleshooting](/user-guide#troubleshooting)
