# Supervised robot walkthrough — 2026-11-03

This is the walkthrough and repair record relocated from the Robot Bible on
2026-11-03. It retains the original explanations, approvals, unresolved questions
and review checkpoints. Status and source hashes identify the recorded work;
they are not a fresh verification of the current checkout or authorization to
resume another task.

The current software map is [Robot software architecture](../SYSTEM_ARCHITECTURE.md).
The [Robot Bible](../ROBOT_BIBLE.md) owns companion purpose and capability navigation.

## Supervised system outline

The sections below are an initial structure, not a completed system review.
Each explanation will distinguish **intended behavior**, **verified source
behavior**, **test evidence**, **live software evidence**, **physical evidence**
and **unknowns**. Source inspection alone establishes neither deployment nor
physical success. Coordinator review and Greg's review are recorded separately.
The coordinator can direct the documentation investigation; that does not grant
implementation approval. Corrections and unresolved disagreements stay visible.

A terminal result can end or settle an operation with failure, cancellation,
rejection or an unknown outcome. It is not necessarily successful completion;
successful completion still needs separate evidence of goal achievement.
Absence of an explicit failed position-verification flag is not physical
qualification.

### Subsystems and boundaries

The [system map](../SYSTEM_ARCHITECTURE.md#processes-and-connections) gives the initial responsibility outline.
Detailed explanations will connect physical firmware and peripherals, Body
Control, the Environment Bridge, MetaHuman Core, cognitive graphs, interfaces,
model services, memory and learning. Existing navigation sources are
[Ainekio's repository map](../../../../Ainekio/docs/REPOSITORY_MAP.md),
[robot software architecture](../SYSTEM_ARCHITECTURE.md),
[MetaHuman architecture](../../technical/ARCHITECTURE.md) and
[Maintained Surface](../../technical/MAINTAINED_SURFACE.md).
These are starting claims to verify, not completed file coverage.

The first source review establishes Body Control's application assembly:
[`server/__main__.py`](#body-control-application-entrypoint) creates one
`GatewayService` and gives that same instance to the dashboard, optional
environment adapter, camera plugin and gait-learning service. Their internal
responsibilities remain to be reviewed. This file neither runs MetaHuman's
cognitive graphs nor implements the robot's servo controller.

The [gait-learning service review](#host-gait-recording-and-learning-service)
establishes a host-side recorder, scorer and optional model-learning lifecycle.
It observes motion selected elsewhere, but it also sends trace-control and gait
model installation/configuration requests. Its saved settings can resume that
work at startup; “does not initiate walking” does not mean “has no device side
effects.” The service, rather than the browser, owns recording tasks and its
robot-maintenance HTTP transport.

### Communication paths and interfaces

For each reviewed handoff, record producer, consumer, transport, endpoint or
call, payload/schema owner, units, identities, acknowledgement and result
semantics. Trace commands and returning observations together. The existing
[protocol reference](../../../../Ainekio/Slave/software/protocol/README.md) and
[software architecture](../SYSTEM_ARCHITECTURE.md) provide navigation; exact
contracts remain unverified here until their implementation is inspected.

The [entrypoint review](#body-control-application-entrypoint) verifies routing
for `/robot` and optional `/environment` on one WebSocket listener, plus a
separate dashboard HTTP listener. Its default ports are 8790 and 8791;
command-line options can change both. `/environment` requires the configured
adapter to exist, a loopback peer and absence of the two relay headers checked
here. Authentication and payload semantics are delegated to the handlers and
are not yet verified by this walkthrough.

### State and lifecycle review

For each reviewed owner, record the state it creates and reads, persistence
location or storage abstraction, startup and shutdown, cancellation, concurrency,
failure and reconnect/restart behavior. Separate intended retention from observed
release behavior. Record runtime evidence only when separately authorized and
obtained. This outline alone authorizes no tests, services or hardware actions;
later specific authorizations and actual evidence are recorded below.

The [entrypoint review](#body-control-application-entrypoint) identifies an
asyncio event loop and a dashboard thread, configured storage paths, and explicit
shutdown calls. Its original startup-failure cleanup gap is corrected in the
bounded candidate below, with isolated failure/cancellation evidence. Persistence
formats, recovery and physical cancellation remain separate contracts, not
qualified by this repair.

The gait service's persistent state is separate from the entrypoint's
`--data-dir`: the entrypoint supplies no gait directory override, so the service
uses `$XDG_STATE_HOME/ainekio/gait-learning`, or
`~/.local/state/ainekio/gait-learning` when that variable is absent. Its
[startup/cleanup explanation](#host-gait-recording-and-learning-service) and
[close completion repair](#gait-service-close-completion-repair) distinguish
closing admission from cleanup completion. Concurrent/repeated close callers
now observe one retained cleanup result; cancellation drains that owner before
propagating. No runtime or physical outcome is inferred from software evidence.

### File-by-file walkthrough

Explanations will be grouped under the subsystem they explain and linked back
to the relevant interface and lifecycle sections. Each checkpoint records:

1. Exact file, relevant symbols, inspected revision/hash and covered sections.
2. Purpose, callers, dependencies and place in the system.
3. Inputs, outputs, owned state and side effects.
4. Errors, timing, concurrency and lifecycle where relevant.
5. Existing tests and the limits of their evidence.
6. Evidence-backed concerns, unknowns, questions and any proposed change.

Only one file advances to owner review at a time. Reading a related caller,
callee or test does not make that other file fully reviewed. Large files remain
partial until all agreed sections have been covered. No implementation file has
yet been marked Greg-reviewed. Both complete-file explanations are
coordinator-reviewed for investigation progression, with the coordinator's
corrections incorporated below. Both remain pending Greg's review.

#### Body Control application entrypoint

**Status: coordinator-reviewed for investigation progression; Greg review
pending.** The coordinator described the explanation as clear and appropriately
bounded, then directed the gait-service review. That documentation review is
distinct from Greg's subsequent repair authorization recorded below.
Originally read all 483 lines of
[`Ainekio/Master/gateway/server/__main__.py`](../../../../Ainekio/Master/gateway/server/__main__.py)
on 2026-11-02. Ainekio HEAD was
`3178eabe0ed9335d222798aeff25fb5dd91af91b`; the working-file SHA-256 was
`dfafaf4c2209471c68622c9dc78e8c9bae3601349604415f5faf80cf9fc069ff`.
The repaired 531-line candidate and its changed execution path have since been
reviewed; current hash and regression evidence are recorded with the bounded
repair below. Original line references in this explanation identify the saved
pre-repair revision, not the changed line positions.
Git reported no changes in the server directory at the original inspection. The owner
identified the previously proposed entrypoint as `server/main.py`; that literal
path is absent. This review uses the existing `server/__main__.py` identified in
the initial proposal, with the filename correction stated in the conversation.

**1. File and symbols.** `main()` selects the normal application or development
stub. `_parser()` supplies command-line and environment configuration.
`_run_production()` assembles the application and its nested `route()` dispatches
connections. `_run_stub()` starts a separate, explicitly selected scripted mode.
Supporting symbols cover WebSocket handshakes (`BoundedHandshakeProtocol`),
disconnect logging (`ConciseWebSocketDisconnectFilter`, `_websocket_logger`),
audit sampling (`MicrophoneFrameAudit`, `_audit_fields`), endpoint reporting
(`_advertised_host`, `_print_gateway_addresses`), transport classification
(`_request_uses_relay`, `_robot_transport`, `_peer_is_loopback`) and initial robot
token seeding (`_seed_environment_token`).

**2. Purpose.** This file starts and connects the components of Body Control.
It constructs one gateway service so the browser dashboard, robot connection,
camera processing and MetaHuman adapter can work through the same application.
The instructions for an individual motion, recognition operation or cognitive
decision live in other owners. The stub branch instead constructs `GatewayStub`
with a configured command list, defaulting to `stand`; it does not build the
dashboard/application assembly. Neither branch was executed during this review.

**3. Callers and connections.** Python's `-m gateway.server` entry invokes
`main()` through the final `if __name__ == "__main__"` block. Limited caller
inspection found that invocation in both the physical launcher
[`Master/start-physical-gateway.sh`](../../../../Ainekio/Master/start-physical-gateway.sh)
and the [emulator stack launcher](../../../../Ainekio/Emulator/start-protocol-v1-stack.sh).
The module is therefore shared startup code, not proof that a physical body is
selected. These launcher excerpts do not establish the current running command.

| Connection made in `_run_production()` | What the inspected file establishes |
| --- | --- |
| `GatewayService` → dashboard, adapter, camera and gait learning | The same service object is passed to all four. Their internal session, command and state contracts are not reviewed here. |
| `/robot` → `service.handler()` | Accepted paths are dispatched with a `lan` or `relay` label, derived from the presence of `CF-Ray` or `CF-Connecting-IP`. This label alone does not verify the actual network route. |
| `/environment` → `adapter.handler()` | This route exists only when an adapter token is configured; the peer must be loopback and neither relay header may be present. Other paths/connections close with code 1008. Actual token validation belongs to the handler. |
| Camera → adapter and gateway | The entrypoint passes recognition publication and camera capture/analysis callbacks to the adapter, and measurement/depth-demand callbacks to the service. Analysis algorithms and callback execution are outside this file. |
| Dashboard → Freestyle and gait learning | It calls `dashboard.start_freestyle()`, attaches a `GaitLearningService`, and awaits that service's `start()`. These calls do not establish that training or motion occurs at startup. |

**4. Inputs, outputs and state.** Configuration comes from arguments and named
environment variables. Direct module defaults bind both listeners to loopback;
launchers can supply other addresses. `--data-dir` defaults to the relative path
`build/gateway`, so its resolved location depends on the working directory unless
overridden. Production startup creates that directory and constructs the
following storage owners; their persistence implementations were not reviewed.

| Configured path under the data directory | Owner/use selected here |
| --- | --- |
| `dashboard-auth.json` | Dashboard password store, initialized with an optional configured password |
| `robot-tokens.json` | Robot token store; an environment-supplied token is inserted only when that robot ID is absent |
| `operations.jsonl` | Audit log receiving selected command, body-event, diagnostic and media metadata |
| `environment-actions.sqlite` | Adapter receipt path, passed only when the adapter is enabled |
| `known-people.json` | Face gallery, constructed only for the configured local detector/recognizer combination |

The entrypoint owns construction, wiring and application shutdown. It retains
no durable goal store of its own. `MicrophoneFrameAudit` owns an in-memory
last-log time and epoch per robot: at most one microphone audit event per second
within an epoch, with a new epoch logged immediately. This samples audit records;
it does not rate-limit microphone delivery in this file. IMU events are omitted
from this audit subscription. `_audit_fields()` selects named metadata keys and
does not copy the raw media payload. Persistence durability, retention, credential
handling inside stores and completeness of outcome evidence remain unknown.

**5. Errors, timing, concurrency and lifecycle.** Recognition can use a configured
URL/model pair or local YOLO weights; selecting both is rejected. Recognition
requires a configured adapter token, not proof of a live Bridge connection. Local
person recognition additionally requires both face models and YOLO. Vision
timeout and maximum-frame-age settings use seconds. The parser defaults are
2 seconds and 1 second respectively; this file validates recognition frame age
as finite and within 0.1–30 seconds. Backend constructors may perform further
validation, which is outside this review.

The main async work uses `asyncio.run()`. The HTTP dashboard's `serve_forever()`
runs in a daemon thread and receives the main event loop when constructed.
The thread starts before camera/depth restoration and gait-learning startup
finish. Whether early dashboard requests are ready for every operation depends
on the dashboard's initialization and has not been established here.

The WebSocket opening handshake has a 10-second timeout. Both server branches
configure a receive queue of 32, disable library periodic pings, and use a
1-second close timeout. This is transport configuration, not a limit on task
count or inference duration. `/environment` removes the whole-message size
ceiling in `process_request()`; other paths retain the imported
`MAX_WEBSOCKET_MESSAGE_BYTES` value, whose definition is not inspected here.
Application-level heartbeat/reconnect behavior belongs to other owners.

Production SIGTERM schedules completion of a stop future on the event loop.
The repaired entrypoint first stops HTTP accepts and closes the dashboard
listener, calling shutdown/join only when its serving thread started. It then
closes the WebSocket listener, gait service once, gateway sessions and remaining
sockets, and waits for WebSocket handlers before camera cleanup. Signal
restoration, Freestyle, camera and host-audio cleanup retain independent
finalization even if an earlier closer raises. The existing 2-second dashboard
thread join timeout is unchanged. Gait failure/cancellation semantics remain
separate defects; the entrypoint does not retry its closer. No explicit adapter
or hotspot-wide close is added. Per-action cancellation and
physical stopping are delegated, not established by these application-level
calls. `main()` catches `KeyboardInterrupt` and returns 130; other errors
propagate rather than becoming a success result.

**6. Existing tests and evidence limits.** Supporting file coverage remains
distinct from Greg review. The bounded repair now has 20 passing gateway
security/startup tests and four passing selected recording/depth checks, after
the original failure was reproduced. Exact commands and isolation limits appear
below. The handshake and recognition suites listed here were not run for this
repair; no historical pass is claimed as current evidence.

| Existing test source | What its inspected assertions cover; limits |
| --- | --- |
| [`test_gateway_security.py`](../../../../Ainekio/Emulator/tests/test_gateway_security.py) | The maintained module passes 22 tests. Startup coverage includes adapter on/off, partial acquisition, cancellation, independent cleanup failures and ordering. One case uses real gait start/close/to_thread with isolated corrupt saved state and proves normal writer exit before teardown. Other external components are fakes; this establishes tested software unwinding, not physical shutdown or live deployment. |
| [`test_gateway_handshake_timeout.py`](../../../../Ainekio/Emulator/tests/test_gateway_handshake_timeout.py) | Local-socket tests assert incomplete-handshake closure and acceptance of a large `/environment` payload while `/robot` retains its message-size limit. They exercise a fixture receiver, not production authentication or actual speech playback. |
| [`test_yolo_backend.py`](../../../../Ainekio/Emulator/tests/test_yolo_backend.py), [`test_recognition_backend.py`](../../../../Ainekio/Emulator/tests/test_recognition_backend.py) | Inspected cases check parser environment/argument precedence, conflicting backend rejection, and selected invalid recognition settings failing before data-directory creation. They do not cover every later startup failure. |

**7. Original defect and resulting behavior.** The original `_run_production()` starts Freestyle
and the dashboard thread at lines 321–327, then awaits camera restoration at
341–342 and gait startup at 354. Its cleanup `try` begins only at line 380.
An exception during those earlier startup steps bypasses the explicit cleanup
at 415–424. The original real corrupt-bank regression demonstrated a pending
writer before fixture teardown; eight early-startup subcases also missed gateway
cleanup. The corrected entrypoint passes those same tests. Live process-exit and
physical effects remain unverified.
Even inside the outer cleanup scope, a hotspot-start or listener-bind failure
does not enter the inner block containing `service.close()`. Existing inspected
startup coverage now exercises those failure paths through the changed owner.
No duplicate controller or unused execution path is established by this review.

**8. Owner question and possible change.** Does this description match the
intended role of Body Control's startup owner? One candidate improvement for
later consideration is to make this same `_run_production()` owner release
already-started components when later setup fails, extending its existing
cleanup responsibility. The candidate edit belongs in this file, with regression
cases in the existing `test_gateway_security.py` startup suite. It requires
understanding the dependencies' close semantics first: moving cleanup can cause
double closes, change shutdown order, or close a component before it is ready.
Verification would inject failures after resources start and assert release
using isolated fixtures, alongside the existing adapter-on/off startup cases.
This source-based proposal led to the bounded repair below, which Greg has now
authorized. Its implementation and regression evidence are tracked there;
authorization does not establish that the defect has been repaired.

#### Host gait recording and learning service

**Status: coordinator-reviewed with cleanup-contract corrections; Greg review
pending.** The coordinator independently read this file and requested the
sequential/concurrent/cancelled/failed-close distinctions and targeted follow-up
below. That review is distinct from Greg's later repair authorization. Originally
read all 792 lines
of [`Master/gateway/gait_learning_service.py`](../../../../Ainekio/Master/gateway/gait_learning_service.py)
on 2026-11-02, at Ainekio HEAD
`3178eabe0ed9335d222798aeff25fb5dd91af91b`. Working-file SHA-256:
`773fa53a1472708acd8ec4b85dfb8f96c985169d9f53876b384e078c6f692cd6`.
Original line references below identify that inspected revision. The subsequent
827-line close-lifecycle checkpoint and hash are recorded in its repair section;
the consolidation checkpoint relocates transport definitions (756 lines), followed
by the parked recorder candidate (833 lines); the subsequent bank consolidation
leaves that bank checkpoint at 832 lines; the current cleanup-drain candidate is 817 lines.
Git reported no changes to this file at the original read. The initial explanation used source and
inspected test assertions only. Four selected recording/depth checks have since
passed for the entrypoint repair below; no training, requests to a real robot or
live services were run. The gait service close owner is now repaired separately
below; the consolidation changes only transport imports in the accepted startup
implementation/tests.

**Purpose and complete-file scope.** `GaitLearningService` records ordinary
motion, associates feedback and camera measurements with gait windows, maintains
candidate/incumbent model history, and optionally proposes and installs learned
models. It does not issue walking, Stop, Home or joint-target commands in this
module. Its supplied `RobotLearningTransport` now lives in
[`robot_learning_transport.py`](../../../../Ainekio/Master/gateway/robot_learning_transport.py)
and implements authenticated maintenance HTTP requests. Other reviewed functions cover atomic JSON replacement, optimizer
observation grouping, settings, status/history, gateway callbacks, recording,
scoring, analysis, pending model application and history restoration. The
underlying optimizer, scoring mathematics, camera algorithms and firmware
handlers remain separate unreviewed dependencies.

**Callers and interfaces.** The [application entrypoint](#body-control-application-entrypoint)
constructs this service with its own `RobotLearningTransport`, camera measurement
callback and depth-demand callback, then awaits `start()`. Dashboard code
references its status and control methods; related caller excerpts are supporting
evidence, not full dashboard coverage. The constructor subscribes to gateway
commands, events, camera frames and diagnostics at lines 141–144.

The transport obtains the robot address from `gateway.maintenance_address()` and
the token from the existing token store. It uses port 80, `/api/<endpoint>`, bearer
authentication, and an HTTPConnection timeout of 30 seconds. A missing payload
selects GET; a payload selects POST. This is not a whole-service shutdown deadline.
Endpoints used here include `servo-feedback`, `gait-learning` and `firmware`.
Trace operations parse newline-separated JSON; other responses parse one JSON
value. The specific trace-session conflict becomes `TraceSessionChanged`;
other non-200 responses raise with the response text. No request retry occurs
inside the transport. The recorder separately retries its drain loop after
selected failures, using the current trace cursor; that is not proof every
device-changing operation is replay-safe.

**State and learning side effects.** `settings.json` is loaded in the constructor.
Per-robot state lives below the first 20 hexadecimal characters of the robot
ID's SHA-256: `training.json`, `previous-contexts.jsonl`, and uniquely named
recording folders containing trace, command/event, camera, measurement and scoring
records. Settings/banks use `atomic_json()` (file fsync and replace); append
recordings use the writer queue. This does not establish power-loss durability
of every recorded sample. `configure()` serializes a shielded settings
transaction so cancellation does not publish a later save before an earlier
dispatched write finishes. `history()` only reads/copies saved history.

Trace samples use device microseconds; host receipts use monotonic seconds;
status clock values are converted from milliseconds. Target/measured/correction
positions are treated as millimetres; named acceleration fields use m/s² and
reference twist uses m/s and rad/s. Camera clock alignment is expressly
approximate (`exposure_synchronized=False`). Units/meaning of remaining policy
feature indices require their producer/scoring contracts and are not inferred.

`_consume()` groups eligible tracking by boot/session, command, gait/profile,
model and requested-rate identity. Lost records discard the current window;
unusable observations are counted without fabricating zero error. Scored windows
feed `_observation()` and saved banks. `_analyze()` distinguishes host-only manual
proposals while learning is off from learning-mode comparison, candidate
projection and promotion. The implementation's promotion criteria are not proof
of real-world improvement. `_apply_pending()` sends `install` followed by
`configure(enabled=True, amount=1)`; `restore()` disables learning and queues a
saved model for persistent installation. These are device-changing operations,
even though the service does not initiate locomotion.

**Startup and partial-start failure.** At original line 147 (current [`start()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L76)),
`start()` creates the storage writer before reading saved robot banks at
152. With saved learning enabled it queues a candidate/incumbent model at 155;
with logging or learning enabled it starts a recorder at 157. Thus a later
robot's invalid/unreadable bank can raise after the writer and earlier recorders
exist. `start()` has no local rollback. The original entrypoint called it outside
the cleanup scope; the repaired entrypoint now invokes the existing close once
after this partial-start failure. That handoff is proven with a real service and
corrupt isolated bank, not a change to this service's own cleanup semantics.
Calling `start()` twice overwrites the writer reference without stopping the
previous writer; the reviewed entrypoint calls it once, so repeated startup is
an unsupported lifecycle case, not an established production trigger.

**Normal cleanup and transport ownership.** The repaired
[`close()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L756) sets
`closed` as a stopping/admission signal and retains one `_finish_close()` task.
That task removes the diagnostic callback, cancels/awaits recorder and analysis
tasks, closes the supplied transport, and independently attempts writer release.
The existing FIFO sentinel follows already queued writes; awaiting the writer
establishes its real terminal result without hanging on a dead writer's queue.
Concurrent and repeat callers share completion/failure, while cancelled waiters
drain it before propagating cancellation. The detailed contract and failure
limits are recorded in the close repair below.
It owns transport cleanup in the reviewed entrypoint's composition. Commands,
events and frames are not explicitly unsubscribed here; most recording admission
checks `closed`, but `event()` can still update runtime/pose state. Targeted
gateway inspection establishes that its close releases sessions without clearing
the callback lists; this batch does not change that separate lifecycle contract.

The relocated transport's [`close()`](../../../../Ainekio/Master/gateway/robot_learning_transport.py#L44)
locks each robot session, closes its connection and sets it to `None`.
Successful repeated calls find no connection. It does not permanently disable
`request()`; a later request can reopen a connection. Persistent requests share
the per-robot lock; sparse (`persistent=False`) requests own and close individual
sockets. HTTP/storage/optimizer operations are dispatched through `to_thread`;
the module has no explicit mechanism to cancel already executing thread work.
Cancelling its asyncio waiter alone is not evidence that remote work or optimizer
subprocesses have stopped. Optimizer subprocess ownership remains unreviewed.

**Specific concerns and evidence boundaries.**

| Finding | Source evidence and consequence |
| --- | --- |
| Partial startup needs its caller's cleanup owner | `start()` lines 147–157 allocate before later reads; no local startup rollback. The original entrypoint skipped cleanup and the real writer remained pending in the regression. The repaired caller now executes close and the writer exits normally before fixture teardown. Close completion and recorder release are repaired separately below. |
| Sequential successful repeat | The retained cleanup task returns its result without re-executing resource cleanup. |
| Concurrent close caller | Repaired: concurrent callers wait for that same task instead of returning on the early `closed` flag. The entrypoint retains gateway/camera dependencies until it finishes. |
| Cancelled close caller | Repaired: repeated waiter cancellation is drained, then propagated after cleanup. A simultaneous cleanup failure stays visible as the cancellation cause, while other callers receive the shared failure directly. |
| Failed transport cleanup | Repaired: writer release runs independently, real queued temporary records drain, and all ordinary/repeat callers receive the retained failure. Transport cleanup is attempted once, with no automatic retry. |
| Independent recorder release | Implemented in the parked/unaccepted candidate at [`_release_recording()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L437): a synchronous depth-release submission failure is retained while the owned trace stop/drain is still attempted. Native background camera close/reset errors remain asynchronous logger results, not exceptions claimed to escape into `_record()`. |
| Trace-stop acknowledgement and drain | Parked/unaccepted implementation: a failed stop acknowledgement leaves the old owned identity uncertain; a later drain failure is distinct from an acknowledged inactive trace. Both persist a terminal event in the existing recording and fail status/close. A session conflict clears ownership without stopping the replacement. |
| Shutdown does not own every admitted operation | `configure()` creates a shielded transaction at 179; `close()` does not track/await it. The original entrypoint allowed new HTTP configure/analyze/restore admission during component cleanup. The candidate stops HTTP accepts first, but already accepted daemon workers are not drained by dashboard server close, and a call_gateway timeout does not cancel the submitted coroutine. No new admission guard or operation-drain mechanism is added. |

`_record()` acquires depth only during active walking and requests it with
`wait_for_measurement=False`. It tags device trace ownership with boot/session,
stops only a trace it marked owned, drains remaining trace records, and reconciles
re-enable after normal completion. Those intended release paths do not prove
successful release under every exception. Cancellation during an already
dispatched `trace_start` also needs examination: `owned=True` is assigned only
after the awaited response at lines 461–462; the actual device outcome is then
unknown until correlated evidence establishes it.

**Existing tests, inspected but unrun.** Supporting excerpts of
[`test_gait_learning_service.py`](../../../../Ainekio/Emulator/tests/test_gait_learning_service.py)
were read at lines 1–236, 305–362, 446–490, 825–878 and 930–1052; the file is not
fully reviewed. Its inspected hash was
`1bc9d11b6708087a982628ab22f1727527dc0cb9841750f3580e18b86f8c2474`.
Assertions cover atomic-save failure, serialized/cancelled configuration,
transport socket reuse and no retry, trace-session conflict, recording without
browser control, saved logging restart, and repeated recording/depth ownership.
`test_service_close_cancels_recording_without_waiting_for_depth` at 1014 uses the
real camera plugin with simulated depth work and a fake robot transport; the fake
transport has no `close()` method. It checks trace release and an empty write
queue but not real persistent HTTP shutdown. The successful close is followed by
registered cleanup, exercising repeated calls without a fault. The inspected
assertions do not establish cleanup after corrupt saved-bank startup, a failed
transport close, concurrent close callers, or a depth-release exception.

**Targeted follow-up, not additional whole-file reviews.** At the coordinator's
direction, camera release, gateway close/callback dispatch, dashboard construction
and request dispatch, and existing component close methods were read only to
bound the startup-cleanup proposal below. No further whole-file review began.
The gait service's close completion/failure behavior was subsequently authorized
as its own bounded repair below. Trace-release reporting and independently
admitted operation lifecycles remain separate; neither is silently included.

### Gait service close completion repair

**Status: independently coordinator-reviewed and ACCEPTED for the bounded
software repair at the checkpoint hashes below.** The subsequent recorder
candidate remains parked/unaccepted. Greg's earlier repair authorization, as directed by Repair
Coordinator `01a19eb4-9589-7f70-bdc3-f50a49b39d4d`, covers this existing lifecycle
owner. It does not mark the source Greg-reviewed or qualify live/physical
behavior. Before the import-only consolidation, the accepted startup files had hashes
`1a46a7e0e1b7142b821290f9776be2f40534be9c86ab85e41726eb7642365819`
and `7f973793a6ea5212383f681554055629b3179e2c4e22686cd79ab263cebb0dd6`.

Only `Master/gateway/gait_learning_service.py`, its existing
`Emulator/tests/test_gait_learning_service.py` suite and this Bible changed in
this batch. Private originals and hashes were saved before edits under
`gait-close-originals/` in the existing
`/home/greggles/Documents/Codex/2026-11-02/startup-cleanup-baseline-20261103T001416Z`.
No whole-repository snapshot or runtime/training-store copy was repeated.

**Cause and resulting contract.** The old `closed=True` early return conflated
closing admission with completed cleanup. It allowed observers to return while
another close was running, and made interrupted or failed cleanup appear
successful to later callers. Transport failure also skipped writer completion.
`GaitLearningService` remains the sole owner of its recorder/analysis tasks,
supplied transport and storage writer. Its new `_close_task` retains exactly one
execution of `_finish_close()`. `close()` and the recorder finally now delegate
the cleanup wait/result algorithm to the same owner-local `_drain_cleanup()`;
`configure()` retains its separate transaction-failure contract. Successful, failed and concurrent callers observe that task's
actual result without another cleanup attempt. A cancelled waiter stays waiting
until cleanup finishes, then raises `CancelledError`; when cleanup failed too,
the cancellation retains that error as its explicit cause. Other callers and
repeated calls still observe the cleanup failure directly.

**Cleanup-drain consolidation: locally verified, coordinator review pending.**
Both duplicated wait/result bodies are removed in favor of
[`_drain_cleanup()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L762).
It preserves captured/repeated waiter cancellation and cleanup errors as causes.
The retained `_close_task` identity preserves the distinct shared-close versus
private-release owned-cancellation outcomes. Task acquisition, both finalizers
and `configure()` are unchanged; there are no new tasks or policy flags.
Production is **+7/−22, net −15** versus the accepted 832-line bank checkpoint;
**40 checks pass**, including three new owned-cancellation cases that also pass
on the duplicated baseline. Exact retired bodies, hashes and logs are in the
existing private baseline's `cleanup-drain-*` artifacts. This preserves behavior,
including the existing limits of internally cancelled cleanup; it is not a
recovery or device-stop qualification. The recorder candidate remains unaccepted.

Transport cleanup and writer cleanup are nested independent finalizers. A
healthy writer consumes the existing FIFO sentinel after admitted records and
exits normally. Waiting for the writer itself replaces the earlier join-before-
sentinel order, which could hang forever with a dead writer and pending records.
A failed writer's actual exception propagates; pending queue entries are not
purged or retried. Pending records without a started/completed writer produce a
visible failure rather than false completion. This is cleanup-result reporting,
not a new recording restriction or recovery worker.

**Isolation and red/green evidence.** `CloseLifecycleTests` uses the real service,
start/close/writer and `asyncio.to_thread`, explicit temporary directories,
disabled settings and existing fake gateway/transport fixtures. New external
request methods fail on use. Real JSONL records are read back where drain is
asserted. Fixture emergency cleanup occurs only after assertions and cannot
establish the production cleanup result. Its entrypoint test reuses the accepted
startup fixture with a real gait service: blocked transport cleanup plus repeated
cancellation cannot advance gateway/camera teardown, and cancellation remains
cancellation once writer cleanup completes. No accepted startup file was edited.

On the unchanged close, seven focused tests produced five assertion failures
and two writer-edge timeouts (`gait-close-before.txt`); the normal/partial-start
case already passed. On the correction, all seven pass. After inspecting the
neighbor fixtures, the following owner command passed **21 tests**:

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v \
  Emulator.tests.test_gait_learning_service.CloseLifecycleTests \
  Emulator.tests.test_gait_learning_service.GaitStorageTests \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests
```

Coverage includes blocked concurrent close, successful repeats, repeated waiter
cancellation with another observer, cancellation plus transport failure,
transport failure with verified JSONL drain and normal writer exit, partial
startup, and failed/unstarted writers retaining pending entries. Existing
configuration/storage and simulated recording/depth cases continue to pass.
The accepted gateway startup command also passed **22 tests** with the changed
dependency:

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v Emulator.tests.test_gateway_security
```

Logs in the original private baseline are `gait-close-after-focused.txt`,
`gait-close-after-owner.txt` and `gait-close-handoff-startup.txt`. Production/test
diff review and AST comparison establish that only initialization of the retained
task, `close()` and `_finish_close()` change in production; pre-existing owner
test classes and accepted startup source/tests remain unchanged.

| Gait-close checkpoint before transport relocation | SHA-256 |
| --- | --- |
| `Master/gateway/gait_learning_service.py` (827 lines) | `9f6d43ab856d8ab51af1f9af706b06694a9c6262d0e1239ac91a09d412b23114` |
| `Emulator/tests/test_gait_learning_service.py` (1302 lines) | `dfaf97e893e5e3e11bc6a3fa1a7f31dc71f755ea86d8bf6e032ec7e20bbbfd5a` |

In decision `01a19f20-4bc4-7620-981e-03d6031d4ad3`, Repair Coordinator reported
its independent review of the full close/initialization diff,
real FIFO writer, tests and red/green logs. Its independent repeated-cancellation
and actual-entrypoint dependency-order regressions passed **2 checks**. The
decision accepts the retained cleanup task, independent transport/writer
finalizers and cancellation/failure retention at these exact hashes. This
records the coordinator's reported verification; no suites were repeated merely
to acknowledge it. Acceptance does not extend to subsequent recorder additions,
the newer whole-file candidate, Greg source review or live/physical qualification.

**Limits retained.** Independently admitted dashboard configure/analyze/restore
work can still race with shutdown; its ownership is not repaired here. Existing
analysis task-result interpretation remains unchanged. Recorder cleanup and
its close-result handoff are corrected in the subsequent repair below. Adapter
closure, constructor-internal failures and repeated start remain separate.
The writer's existing per-record storage-error policy is unchanged: normal worker
exit is not a blanket assertion that every earlier disk write succeeded.
Unexpected writer failure preserves still-queued records in memory; this is not
a new durable recovery guarantee for unpersisted data. No retry, queue purge,
new manager, timeout, live service/model/training call or physical action was
introduced. Source/software evidence is not live or physical qualification.

### Saved-bank restoration consolidation

**Status: independently coordinator-reviewed and ACCEPTED for the incremental
subtraction at the hashes below.** The two `start()` / `_record()` bank hydration
and pending-model reconstruction bodies are removed; one service-owned
[`_load_banks()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L95) remains.
Startup loads saved banks even with both flags off and checks its captured settings
after the threaded read. Recorder fallback runs only for empty banks and checks
current settings after that read. Populated banks/pending work, missing/corrupt
failures and activation/repeated-start policies are preserved. Only learning-enabled
loading restores converged incumbent or candidate with `persist=False`.

Bank production: **+12/−13, net −1**; tests **+195/−0**. The checkpoint's cumulative
**+76** versus the accepted 756-line owner checkpoint includes the **+77 parked,
unaccepted recorder change** and is not accepted cleanup. Seven bank tests pass
before/after consolidation; 37 focused owner checks pass. The coordinator independently
reran all seven bank tests: **PASS (0.058s)**, with fake external boundaries and
temporary state. This is software evidence, not Greg source or live/physical review.

Exact patches, commands and counts remain in the existing private baseline's
`bank-consolidation-*` artifacts and `bank-consolidation-originals/`.
`bank-consolidation-hashes.json` identifies the accepted source/tests and saved
Bible `2a1514363fa3c5453abff43afbb3414e1648a8280ec0871aba0cbb0618249db0`;
concurrent older-checkpoint acceptance updates remain in the working Bible.

| Accepted bank checkpoint | SHA-256 |
| --- | --- |
| `Master/gateway/gait_learning_service.py` | `d2e8f14a062539f22c0b9a33dc1c2a863cdf798729f59facbdb22e8d444a589a` |
| `Emulator/tests/test_gait_learning_service.py` | `47a6b366c14e96c0514867f20db3a223231afa51955babd52e52b703f75b966c` |

### Recorder release and close error handoff

**Status: PARKED / UNACCEPTED.** This recorder candidate adds 93 and removes
16 production lines (net **+77**). Greg's newer subtraction-first direction
requires a specific exception before a necessary net-additive production repair
can proceed. Earlier general authority does not supply that exception. Its exact
source/tests/Bible checkpoint, patches and evidence are preserved in the existing
private baseline; the release/close code remains intact in the working tree.
It is not extended or counted as an accepted cleanup. No source is Greg-reviewed.
Only the existing gait service, its gait test suite and this Bible changed in
this batch. Scoped originals/hashes are in `recorder-release-originals/` under
the same private baseline; no new census, store backup or master document exists.

The reproduced defects were an early depth-release submission exception skipping
trace stop, and swallowed stop/drain failures followed by an off/unowned state.
The [recorder](../../../../Ainekio/Master/gateway/gait_learning_service.py#L333)
now drains its shielded release task through repeated waiter cancellation.
Its existing owner performs independent depth release and owned trace cleanup;
there is no new manager, retry, stop command, timeout or background recovery.

Every stop/read remains fenced by the affected boot/session. Unowned traces are
not stopped; a confirmed session conflict never triggers a stop of its replacement.
Missing identity causes a visible failure without an unfenced request. The
existing stop response must identify that same inactive trace before it is
reported acknowledged. A later malformed/read failure is a drain failure. The
existing recording retains partial returned trace data and an `events.jsonl`
`recording_cleanup` event with boot/session, `trace_stop_acknowledged`,
`trace_drained` and stage/error entries. A final drain flag means the response
reached its final footer; it does not certify absence of lost samples, physical
motion completion or successful native camera-model unload.

Errors are combined using Python's exception groups, remain in the existing
`recording_unavailable`/error status, and prevent automatic re-enable
reconciliation after failed cleanup. Public status remains JSON-safe text.
The existing runtime error field retains the actual cleanup result so that
[`_finish_close()`](../../../../Ainekio/Master/gateway/gait_learning_service.py#L784)
can report it even after a cancelled recorder's task result has been observed.
Non-cancellation recorder failures are no longer discarded by gather. Transport
and writer releases remain independent nested finalizers; concurrent/repeated
close observers receive the same actual result without retry. Cancellation is
propagated after release, with simultaneous cleanup failure retained as its cause.
Other finalizer errors remain visible through the existing exception context.

Terminal recording evidence is enqueued directly under the existing recording
owner even after logging is disabled or `closed` prevents `_observe` writes.
It precedes the writer sentinel. Tests read these real temporary files and prove
normal writer exit before fixture teardown; they do not substitute fixture
cleanup for that proof. The writer's existing per-record disk-error policy is
unchanged, so worker exit alone does not certify every historical write.

**Separate red/green evidence.** The earlier close repair retains its seven-case
red log and 21-owner/22-startup green logs. The recorder's saved pre-change source
already contains that close fix and transport relocation. Against that source,
13 new recorder cases produced eight assertion failures and five errors
(`recorder-release-before-final.log`). Some preserved-success scenarios fail on
the missing final evidence rather than incorrect stop ownership. An initial
fault fixture also failed the first inactive read; it was corrected to fail only
after stop, and the corrected cases were rerun on the saved original. No lifecycle
method was mocked. A mistyped neighboring test selector produced a loader error;
the corrected final command passes, and that failed attempt is not counted green.

The final owner command passed **30 checks** (13 recorder, seven close, nine
recording/depth and one existing device-replacement check):

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v \
  Emulator.tests.test_gait_learning_service.RecorderReleaseTests \
  Emulator.tests.test_gait_learning_service.CloseLifecycleTests \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests \
  Emulator.tests.test_gait_learning_service.ServiceTests.test_device_restart_reacquires_trace_without_old_cursor_or_window
```

The 13 recorder checks were repeated after replacing an internal-state assertion
with the stronger public JSON-status assertion; all pass. Coverage includes
independent/combined depth and stop failures, acknowledged-stop drain failure,
unowned/replaced sessions, invalid active stop replies, successful disable/re-enable,
repeated cancellation, transport-failure context and the actual entrypoint handoff.
The entrypoint test keeps gateway/camera dependencies until recorder release ends,
then verifies cancellation plus failure cause and normal writer exit. Fixtures use
real service/queue/files/`to_thread`, temporary state, learning disabled and fake
robot/depth/HTTP boundaries. No model, training, network or hardware is exercised.
Unchanged startup/socket and transport-neighbor evidence is reused rather than
rerun; source/test hashes for those owners remain unchanged from consolidation.

| Combined candidate | SHA-256 |
| --- | --- |
| `Master/gateway/gait_learning_service.py` | `ebc70545dad0793d0b249ba8cefae4376e3dea039a0b948f394523b589aef0b0` |
| `Emulator/tests/test_gait_learning_service.py` | `10f94a9330b91a3de4485f7b82572aa9ff4d96e2094ff6bb543769e415ab746b` |

**Remaining boundaries:** independently admitted dashboard mutations/analysis,
adapter closure, constructor-internal cleanup and trace-start cancellation before
an ownership response remain separate. Native depth-release worker errors still
belong to the camera logger; only submission faults are handled here. HTTP stop
failure leaves the device result unknown; no retry or invented successful stop
is performed. Source/software evidence is not live or physical qualification.

### Task-contract and maintenance-transport consolidation

**Status: independently coordinator-reviewed and ACCEPTED at all 35 saved
states in `consolidation-hashes.json`.** This acceptance covers that ownership
checkpoint, not later recorder or bank edits. Relocation alone does not satisfy Greg's newer
net-reduction requirement for cleanup batches. This historical acceptance does
not qualify live/physical behavior or mark source Greg-reviewed.
This is consolidation, separate from the preceding gait-close defect repair.
No source is thereby marked Greg-reviewed. The safe gait-close checkpoint is
preserved. The recorder-release follow-up above is parked/unaccepted; dashboard
mutation-boundary work remains deferred to its separate owner review.

| Responsibility | Before | Surviving owner and removed dependency |
| --- | --- | --- |
| Task schema, decision types, validators, context/envelope construction, projections and delegation | Node-layer `environment/helpers.ts` plus `planning-contract.ts`; domain training evidence depended on them | [`environment-interface/task-selection.ts`](../../../packages/core/src/environment-interface/task-selection.ts); both old node files are removed, without shims |
| Authenticated maintenance HTTP and trace-session conflict identity | Defined inside the recorder/optimizer lifecycle module; dashboard/Freestyle imported that module for transport | [`robot_learning_transport.py`](../../../../Ainekio/Master/gateway/robot_learning_transport.py); both definitions and the unused `http.client`/`threading` imports are removed from gait service |

The transport source contains only its four actual standard-library imports.
Gait service imports the exception through the transport module, without retaining
old-path class/exception aliases. It remains the owner of its supplied persistent
transport and recorder/analysis/writer cleanup. Dashboard supplies the same sparse
transport to the dynamically loaded Freestyle Bridge; the Bridge still owns its
closure. This removes that import's dependency on recorder, optimizer and training
modules; it does not claim that the full gateway never imports those modules.

**Consumers and removals.** Twenty-three MetaHuman consumer files changed imports:
Core and nodes public barrels; the training-evidence reader; Active Task's inline
type reference; Environment context/parser/planner/active-task nodes; LLM
orchestrator/router; robot-operator context; execution-context node; and eleven
existing test files spanning those contracts, robot status and domain task tests.
Brain has no direct old-path import requiring an edit. Its existing public imports
remain valid. The category export lists and `collectNodes` registration path do
not register either removed utility module. Searches of maintained source,
scripts and saved graph/configuration references find no remaining old module
specifier. Dated audits/generated historical inventories retain their dated
paths as historical evidence, not current import instructions.

Ainekio consumers are the gait service's trace-conflict handler, entrypoint
construction, dashboard `_setup_freestyle`, existing gait/transport tests and the
startup fixture's transport-constructor patch target. The optional Freestyle
loader passes the supplied transport into `Bridge`; no extra transport import or
registration exists in that experiment. The dashboard change is exactly one
import; its pre-existing motion-review/export edits are preserved.

**Preservation and evidence.** The task/delegation bodies are byte-identical
apart from the required inline type-import path; static import paths also change.
Every prompt, schema and description string and validation/selection body is
preserved. TypeScript compiler export snapshots match: 1,816 root Core symbols
and 55 nodes symbols. All 218 `defineNode` call sources match, including IDs and
schemas. The transport class and exception match both raw source and Python AST.
Gait service matches its checkpoint except the relocated exception reference;
startup matches except the transport import. There is no new manager, retry,
timeout, compatibility source, model assignment or behavioral restriction.
An isolated import probe also loads the actual optional Freestyle Bridge module
and transport without importing gait service, optimizer or training modules;
it constructs no instances and sends no requests. Scoped diff/whitespace checks
pass in both repositories, including the new modules.

The coordinator independently compared all 54 task/delegation declarations,
accounted for the 23 consumer edits and two import merges, and confirmed the
transport/exception source and AST, gait exception reference, and narrow dirty
dashboard/startup import changes. It independently reran **4 transport owner
regressions** and the actual optional Freestyle import probe: **PASS**, without
instances or network use. These are rechecks of the bounded software change,
not additional physical or Greg source-review qualification. Ainekio's
[documentation authority](../../../../Ainekio/docs/README.md#consolidated-v10-amendments) identifies the
older `freestyle-movement.md` as V1 extension evidence, not a live V2 module
instruction; that historical document remains intact.

After fixture inspection, native isolated checks passed:

- **94 tests**: existing action-parser, context-builder, motion-request,
  request-routing/delegation, training-evidence-bank and Model Router suites.
  The disposable preload supplies temporary state, disconnects event-bus I/O and
  fails network access; existing model calls are faked. SQLite evidence is temporary.
- **52 tests**: existing `CloseLifecycleTests`, `GaitStorageTests`, `ObjectiveTests`,
  `RecordingDepthTests` and gateway-security/startup suite. Real gait start/close,
  writer and `to_thread` remain exercised; HTTP transport uses patched connections.
  Tests print simulated dashboard URLs but open no listener or real robot socket.
- `pnpm typecheck:core` and `pnpm typecheck:brain` pass before and after relocation.
  `pnpm check:architecture` passes with zero violations, using a private index to
  include the new file without staging the working tree or changing its baseline.

The first sandboxed Python attempt stalled after one case and was interrupted;
the first sandboxed Node attempt reported only six file-level results. Neither is
counted as passing acceptance evidence. Approved native reruns above expose the
actual individual checks. An intermediate typecheck caught the moved inline type
import and passed after its relative path was corrected. No test expectation was
weakened. These ownership moves intentionally preserve behavior rather than
introducing a new defect reproduction; earlier lifecycle red/green logs remain
separate evidence.

Private originals/hashes for the 35 scoped paths are under
`consolidation-originals/` in the existing baseline directory. New paths are
recorded absent before the move. No whole-repository snapshot, runtime/config
store copy or training-data backup was repeated. The private incremental patches,
consumer/hash manifest and logs use the `consolidation-` prefix. Production,
test and documentation line deltas are reported separately in the handoff;
there is no line-count target. Consolidation checkpoint owner hashes, before
the recorder repair, are:

| Owner | SHA-256 |
| --- | --- |
| Task-selection contract | `3720fdbd4d1d97ca6594c5d10a6313d8f1563d18145b29da0510477471b443d5` |
| Maintenance transport | `8e461120b6a4f974cc94955c13c2212b61e62b7b86be9436cf951f3166bbf0e2` |
| Gait service after relocation | `360e9369bb19c081621deaf9f681c775592fab528a514fddd41ddd8fdc0fb5e4` |
| Entrypoint after import move | `9383a1860c982062f0064187d31429cb81dba5d70b72453792a6843eae6dd511` |

**Limits:** this establishes source ownership, import/type compatibility and
isolated software behavior. It does not qualify live shutdown, deployment,
physical action or model performance. Recorder trace-result reporting is
corrected below; HTTP in-flight admission, adapter closure and constructor-internal cleanup remain unresolved
within their stated bounds. No configuration, corpus, generator, training data,
model assignment, security setting or live service was changed by this batch.

### Minimal startup-cleanup repair proposal

**Status: bounded repair implemented, locally verified and accepted after
independent coordinator follow-up diff review.** The coordinator reviewed the
prior candidate and found the socket-loop gap corrected below. Implementation and isolated tests were
authorized by Greg, as relayed in this coordinating conversation. That
authorization does not mark every source file
Greg-reviewed. Repair Coordinator's decision
from local session `01a19eb4-9589-7f70-bdc3-f50a49b39d4d` accepts the isolation
and fixture details below. The inspector remains the sole
implementation writer. The repaired problem was that `_run_production()` created
live resources before its cleanup scope and closed the gateway only after
successfully entering the WebSocket serving block. A setup exception could bypass
existing finalizers. The
surviving owner is `_run_production()`; no manager, parallel shutdown service,
retry loop, blanket fallback, timeout or new hardware command is proposed.

**Exact changed files.** Implementation:
[`Master/gateway/server/__main__.py`](../../../../Ainekio/Master/gateway/server/__main__.py),
within `_run_production()` (current resource scope/cleanup at 284–472). Regression coverage:
[`Emulator/tests/test_gateway_security.py`](../../../../Ainekio/Emulator/tests/test_gateway_security.py),
extending its existing `GatewayStartupTests`. The third file is this
[`docs/robot/ROBOT_BIBLE.md`](../ROBOT_BIBLE.md), recording the proposal and later
approved changes/evidence. This is the complete three-file scope. No gait,
camera, dashboard, transport, firmware or configuration edits are part of this
proposed batch.

**Implemented owner correction.** One outer resource-lifetime `try/finally`
starts before gateway construction. Local references identify successfully returned
gateway/dashboard/camera/gait/server objects, whether the dashboard thread
started, and whether the SIGTERM handler was installed. These are construction
facts for cleanup, not a new runtime state owner. Startup configuration,
component construction order and serving behavior are preserved.

The WebSocket `async with serve(...)` has been replaced with the same
`server = await serve(...)` and explicit `close()`/`wait_closed()` in that scope.
This retains the existing WebSocket owner/API and allows gateway sessions to be
released before waiting for their handlers; simply moving gateway close outside
the existing context could wait for those same sessions too early. Keep the
existing per-socket release owner. Its loop now retains synchronous handshake
release failures while continuing other sockets, awaits all established closes
concurrently, and only then reports errors. One failure is re-raised unchanged;
multiple failures are raised in a built-in BaseExceptionGroup (an ExceptionGroup
when all members are ordinary exceptions). No error result is discarded. The
two gait-close call sites are replaced
by one entrypoint-owned finalizer as part of moving acquisition into that scope.
This is not a failed-close retry repair and does not reinterpret `closed` as
cleanup completion. Ordinary nested `finally` blocks cover dependency groups
so one cleanup error does not skip independent
socket/thread release. Errors propagate with
their exception context; no failure becomes a success result.

The teardown-order change stops the existing HTTP serving loop,
close its listening socket and join its serving thread before closing components.
Call `dashboard.shutdown()` only if that serving thread actually started; local
Python's BaseServer contract says calling it without a running serve_forever
thread deadlocks. Always close a successfully returned dashboard's bound socket,
including when thread startup failed. Keep the existing join timeout; add none.
This stops new accepts during cleanup, but does not drain already accepted daemon
request threads or claim their operations completed.

**Resources, ownership and order by reached startup stage.** Each acquired
resource covered by the entrypoint's existing finalizers is passed once to its
current closer. An object whose constructor raises before returning remains that
constructor's responsibility; the entrypoint cannot safely clean an object it
never received. Adapter-wide release remains explicitly unresolved below.

| Reached stage | Owned resources / release obligation in the proposal |
| --- | --- |
| Vision selection, directory/auth/token setup (249–283) | Existing saved data and models are not rolled back or deleted. Constructor-internal resources before a successful return are outside the missing-finally repair. |
| Gateway and optional adapter returned (284–308) | Close gateway sessions even if dashboard/hotspot/bind later fails. Adapter receipt storage remains owned by the adapter; its broader close contract is a stated remainder below, not an invented finalizer. |
| Dashboard returned, Freestyle setup attempted (309–321) | The dashboard already owns a bound HTTP socket, host audio, and any returned Freestyle bridge/recorder. Close partial Freestyle through close_freestyle(), audio through its close(), and the HTTP socket through server_close(). Do not call shutdown() before the serving thread starts. |
| Dashboard serving thread started (322–327) | First stop HTTP accepts with the existing shutdown()/server_close() and join the serving thread. Existing daemon request workers can remain in flight; that is not a task-completion barrier. |
| Camera returned / restoration attempted (331–348) | After any gait cleanup and WebSocket-handler completion, await camera.aclose(). It owns its recognition/metric workers and executors. Do not unload shared depth before its gait or adapter consumers release. |
| Gait service returned / start attempted (350–354) | Await gait.close() even when start() raises after creating its writer. That service owns recorder/analysis cancellation, trace release, transport close and write drain. Its separate cleanup defects remain possible. |
| Signal installed / hotspot startup attempted (374–381) | Restore the old signal handler when installed. RobotHotspot.start() can invoke systemd; the network service is not a process-local disposable resource. Add no hotspot stop, rollback or setting change. |
| WebSocket listener returned (382–392) | Close the listener; close gait while camera and gateway remain available; close gateway sessions; close remaining established/handshaking sockets; then await server.wait_closed(). This keeps handler cleanup before camera/executor teardown. |

After HTTP accepts stop, the full reached-resource order is: WebSocket close,
gait close, gateway close, remaining WebSocket closure and wait_closed, restore
the installed signal handler, then Freestyle close, camera close and host-audio
close. A dashboard that never served still receives server_close(). Nested
finalization attempts independent remaining releases if an earlier close raises;
it does not promise completion of a broken component's own cleanup.

**Which operations can overlap current shutdown?**

| Entry path | Verified source behavior and consequence |
| --- | --- |
| Authenticated POST /api/gait-learning/service | dashboard/server.py 616–654 requires session/CSRF; 814–834 dispatches configure, analyze, restore, history and status through the attached service. call_gateway() at 183–185 submits to the main event loop and waits; it has no shutdown-state check and does not cancel the future on its timeout. The original entrypoint stopped HTTP last; the candidate stops accepts first. Already accepted workers can still submit operations during cleanup. |
| Already accepted HTTP worker | DashboardHttpServer has daemon_threads=True at 83. Local socketserver.ThreadingMixIn excludes daemon threads from its joined set; stopping/joining the serve_forever thread is not a drain of these request workers. Even the proposed earlier HTTP stop leaves already accepted/scheduled operations unresolved. |
| Gateway command/event/frame/diagnostic callbacks | These invoke gait command/event/frame/diagnostic recording callbacks, not configure/analyze/restore directly. Only diagnostics are explicitly unsubscribed by gait.close(). closed suppresses recording admission, but event() can still mutate clock/pose state. GatewayService.close() at 1261–1267 marks closing and closes sessions; it does not clear subscription lists. Dispatch at 1943–1952 and 1986–1990 has no closing check. |
| Recorder / analysis task | _observation() can call analyze() at 640–641; _analyze() can call configure(learning=False) at 743–744. close() cancels/awaits tracked recorder/analysis tasks, but does not own every independently submitted configure transaction. No direct gateway callback route to restore() was found in the inspected sections. |
| Robot-maintenance HTTP | RobotLearningTransport resolves via maintenance_address(); service.py 1885–1891 and _connection() at 1910–1919 do not reject solely on _closing. Existing connections disappear in handler finally at 1235–1251. Already dispatched HTTP calls and later requests from in-flight dashboard work are not made impossible by marking the gateway closing. |

**Explicit remainders.** This batch fixes entrypoint unwind coverage, not general
shutdown correctness. It does not repair interrupted/concurrent gait close,
trace cleanup/error reporting, or in-flight configure/analyze/restore ownership.
It does not cancel already executing HTTP/native/optimizer work. A camera depth
close/reset error in passive-release mode is logged asynchronously, whereas a
synchronous executor-submission failure can still skip the recorder's trace
cleanup. Camera.aclose() itself awaits executor work; no arbitrary cutoff is
proposed.

Targeted adapter inspection also found a persistent ActionReceipts SQLite
connection (action_receipts.py 26–36) with a close() method at 301–303, but no
adapter-wide close method or receipts.close() call in the inspected entrypoint/
adapter path. Adapter connection cleanup handles recovery, camera/audio delivery
tasks and depth consumers, but not all separately tracked action tasks in the
inspected handler finalizer. Closing its database directly from the entrypoint
without proving its producers have ended would be unsafe, so that is excluded
from this minimal batch and is not claimed resolved by socket shutdown.

**Isolated regressions.** The existing owner suite was extended without a new
maintained test harness. It exercises real
_run_production() with local dummy configuration, temporary storage, fake
dashboard threads/listeners/sockets, mocked signal installation, and fake robot,
audio and hotspot owners. Patch only the module-local threading reference, not
global Thread creation used by asyncio. Tests must open no ports, send no real
signals, invoke no systemctl/network/Bluetooth/model inference, start no training,
and send no physical commands.

**Accepted corrupt-bank isolation and completion proof.** Patch the existing
`gateway.gait_learning_service.default_directory` symbol before constructing the
real gait service, returning `Path(temporary_directory) / "gait-state"`. Keep the
patch active through assertions and fixture cleanup. Use a separate temporary
`gateway-state` directory for `--data-dir`: that argument alone does not isolate
the gait service, and this case must not read live saved learning settings.

Create only this settings/bank fixture in the temporary gait directory:

```text
gait-state/settings.json
  {"fixture-robot": {"logging": false, "learning": false}}
gait-state/<sha256(b"fixture-robot").hexdigest()[:20]>/training.json
  {"broken":
```

The bank contents are deliberately invalid JSON. Both settings are false, so no
recorder, analysis or training task is launched, while real `start()` creates its
writer and attempts the bank read. Fake external transport request methods must
fail the test if used; its async `close()` records completion.

Retain the real `GaitLearningService` class before replacing the constructor
symbol with a construction-capture factory. That factory constructs and returns
the real instance, saves it for assertions, and does not pass `directory=` or
replace `start()`/`close()`. Thus the entrypoint's actual default-directory seam
and real service lifecycle are exercised. Leave `asyncio.to_thread` and global
`threading.Thread` real. In particular, do not copy the existing test's patch of
`gateway_main.asyncio.to_thread`: it modifies the shared asyncio module and would
also replace gait-service thread dispatch. Only the dashboard's module-local
`gateway_main.threading` reference receives the fake Thread namespace. The bank
read/JSON failure uses real `to_thread`; fixture files and transient executor
threads are the intended effects.

Immediately after `_run_production()` raises the expected `JSONDecodeError`,
before patch/temporary-directory teardown or test-runner loop cleanup, assert:

- The captured instance's directory is the isolated `gait-state` path.
- Its writer exists and is already `done()`, is not `cancelled()`, has no
  exception, and returns `None`.
- Its write queue is empty and `writes.join()` completes.
- Fake transport close was awaited once; no external request, recorder or
  analysis task was started.

Do not cancel or await the writer to manufacture completion before these
assertions. `_write_loop()`'s only normal return is the `None` sentinel branch;
the already-completed, non-cancelled task returning `None` therefore proves normal
writer exit before fixture teardown. If a baseline assertion fails, emergency
fixture cleanup may close the captured instance afterwards, but that cleanup
does not count as evidence that the entrypoint finalized it.

For normal adapter-on/off cases, replace the old async-contextmanager `serve`
fixture with an async factory returning the fake server. Model both synchronous
`server.close()` and async `server.wait_closed()`, preserve route assertions, and
invoke the captured stop callback without sending a real signal. The separate
failed-gait-close case must assert one close attempt, independent remaining
releases and propagated failure, without inferring writer completion from a fake.

| Injection / case | Required assertion and intended side effects |
| --- | --- |
| Dashboard factory raises; Freestyle setup raises after a dashboard returns; Thread.start raises | Release previously returned owners. For a returned non-serving dashboard, close its socket/audio/partial Freestyle but never call blocking shutdown(). Exceptions inside a constructor before its return are not misrepresented as entrypoint-owned cleanup. Fakes and temporary files only. |
| Camera construction, ground restoration or depth restoration raises | Stop the started HTTP listener/thread and release earlier owners; call camera.aclose() only when camera construction returned. Report the original error. No actual executors or camera models are needed for this owner-handoff test. |
| Real GaitLearningService.start() reads a corrupt saved training bank after creating its writer | Use the exact default_directory patch, disabled settings/corrupt bank, real to_thread/start/close and pre-teardown writer proof above. External requests fail on use; no recorder, analysis or training starts. Only temporary fixture files and transient asyncio/executor work are created. |
| Signal installation or hotspot start raises; WebSocket bind raises | Restore a signal handler only if installation succeeded; close the gait/camera/gateway/dashboard resources already acquired. Hotspot/bind failures are injected, not real system operations. Normal GatewayError handling inside RobotHotspot.start() is not confused with an unexpected propagated error. |
| Normal simulated stop, adapter on/off, established and unfinished-handshake sockets | Use the awaitable serve factory and server.wait_closed fake above. Assert one gait close, gateway release and per-socket close precede wait_closed; assert camera cleanup comes after handler completion, and HTTP accepts stop before components close. Invoke the captured stop callback directly; open no sockets and send no OS signal. |
| An acquired component's close raises | Make fake gait.close() raise a distinctive error and assert it was awaited exactly once. Gateway close, socket close/wait_closed, Freestyle, camera, audio, HTTP/thread finalizers and signal restoration still execute. The error escapes with visible exception context; no overall success or real writer completion is inferred from the fake. This tests entrypoint exception ownership, not a fix to the gait writer/transport defect. |

The HTTP in-flight race is not encoded as a desirable passing expectation. It
remains an explicit limit on this patch's acceptance claim. Greg has authorized
repairs and their routine validation without repeated scope approval. Native
execution and filesystem permission controls still apply. The private baseline
and present execution state are recorded below; this authorization does not
authorize deployment, live operations or new product semantics.

**Current execution evidence and limits.** The private baseline contains original
file hashes and both repositories' staged/unstaged binary patches; applying them
to private temporary indexes reconstructed the tracked worktree at verification.
The production and test targets were clean and matched the reviewed originals.
The Bible also received coordinator authorization/checkpoint updates during this
batch; those additions were preserved while integrating this execution evidence.

`before-valid.txt` in the baseline directory records two regression methods on
the unchanged entrypoint: eight early-startup subcase failures plus the real
writer-done assertion failure (nine assertion failures, no fixture errors).
Two earlier runs exposed missing fake-dashboard attributes; those logs are
retained but are not counted as production-defect evidence. The original-failure
command was:

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v \
  Emulator.tests.test_gateway_security.GatewayStartupTests.test_early_startup_failures_release_acquired_resources \
  Emulator.tests.test_gateway_security.GatewayStartupTests.test_corrupt_saved_bank_closes_real_writer_before_fixture_teardown
```

After the owner correction, the maintained command passed **22 tests**:

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v Emulator.tests.test_gateway_security
```

That includes entrypoint cancellation, 12 startup-stage injections, adapter
on/off routing, established/unfinished-handshake socket ordering, failed gait
close without retry, visible startup/cleanup exception context, and independent
finalizers across ten other injected cleanup failures. The corrupt-bank case
proves a completed, non-cancelled writer returning normally before fixture
teardown, with no recorder/analysis work or external request admitted.

The entrypoint cancellation case was strengthened after the coordinator's
focused review: it cancels `_run_production()` while awaiting its stop future,
before cleanup begins, then asserts every reached finalizer and the resulting
task's cancelled state. `CancelledError` propagates as cancellation. The focused
22-test module passed again with these assertions; cancellation during or
recovery of a broken gait close remains outside this test and repair. The
coordinator also independently checked the locally installed WebSocket context
manager: its exit closes/waits, and wait_closed includes handler completion,
supporting the explicit lifetime and handler-before-camera order used here.

The coordinator's independent candidate review then demonstrated a narrower
socket-loop defect: a synchronous unfinished-handshake transport.close() failure
could bypass gather(), orphan already-created established-close coroutines and
skip later sockets. The pre-correction production/test files are preserved under
`pre-socket-fix/` in the original private baseline directory. The new isolated
permutation regression failed on that production candidate in all six socket
orders (`before-socket-fix.txt`), with established close never awaited.

The corrected owner suite passes 22 tests in `after-socket-fix.txt`. Its new
socket tests cover all six permutations of an established connection, failing
handshake and remaining handshake, assert every release attempt and no orphaned
coroutine RuntimeWarning, and prove concurrent established closes are fully
awaited before wait_closed/camera release. A combined synchronous handshake and
asynchronous established-close failure exposes both errors, rather than
suppressing one. The previous entrypoint cancellation assertions remain intact;
failed/concurrent gait-close semantics remain outside scope.

Four selected neighboring checks passed previously after fixture inspection;
their unaffected evidence is reused rather than rerun for the socket-loop fix:

```sh
PYTHONPATH=Master:Slave/software:Emulator/tests python3 -B -m unittest -v \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests.test_cold_depth_does_not_block_trace_or_recording_shutdown \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests.test_busy_navigation_keeps_its_reference_through_repeated_recordings \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests.test_service_close_cancels_recording_without_waiting_for_depth \
  Emulator.tests.test_gait_learning_service.RecordingDepthTests.test_enable_while_previous_trace_stops_starts_the_next_recording
```

These use real camera/recorder owners with temporary files, fake robot transport
and simulated depth processing. The latest owner log is
`after-socket-fix.txt`; prior owner logs `after-security-cancellation.txt` and
`after-security-final.txt` are retained. The neighboring evidence is
`after-recording-depth.txt` in the private baseline directory. The handshake
suite was inspected but not run because it opens real loopback sockets. No broad
or live suite, service restart, training, model inference, physical action,
publication or commit was performed.

The production/test diffs were reviewed. Only `_run_production()` changes in
production; the former context-managed inner shutdown and duplicate gait closer
are removed, while routing, construction, transport settings and component
owners remain. GatewaySecurityTests' existing assertions remain intact. The gait
service was unchanged by this accepted startup batch; its subsequent close-owner
repair is recorded separately above. Accepted startup hashes are:

| File | SHA-256 |
| --- | --- |
| `Master/gateway/server/__main__.py` (531 lines) | `1a46a7e0e1b7142b821290f9776be2f40534be9c86ab85e41726eb7642365819` |
| `Emulator/tests/test_gateway_security.py` (620 lines) | `7f973793a6ea5212383f681554055629b3179e2c4e22686cd79ab263cebb0dd6` |

Repair Coordinator's independent follow-up review accepted this bounded batch
at the production/test hashes above. The original isolated synchronous
handshake-close probe was repeated on the correction: the established socket's
close was awaited once, the original RuntimeError remained visible,
wait_closed/camera release ran, and no orphaned-coroutine warning occurred.
Independent AST comparisons confirmed that production outside _run_production
and the pre-existing startup methods were unchanged, with exactly one
entrypoint gait finalizer. The 22-test owner log and original six-order failures
were inspected; the four unaffected neighbor results were reused. No further
code changes or repeated checks are required for this batch.

This is acceptance of the bounded source/software-test repair. It does not
qualify live shutdown, resolve already accepted HTTP work or any of the explicit
gait/trace/adapter/constructor remainders above, or imply Greg reviewed every
source file. No new capability repair began as part of this review.

**Targeted evidence snapshots.** These files remain partial, with no whole-file
or Greg review claimed. All hashes below identify the working files read in this
diagnosis; Ainekio HEAD remains the revision recorded above.

| File / inspected sections | SHA-256 |
| --- | --- |
| [dashboard/server.py](../../../../Ainekio/Master/gateway/dashboard/server.py): construction, Freestyle close, call_gateway, authenticated POST/gait dispatch, factory | `25601f9cf32bb21b39df9cf700a8938acf8fc4a8a61ff4ccc06f8f00609f1082` |
| [server/service.py](../../../../Ainekio/Master/gateway/server/service.py): connection close/admission, service close, subscription management/dispatch, maintenance address | `4795deef4a1d848a5b5b1334fd1669d36987e3664788f7b1c51546df13a310c8` |
| [plugins.py](../../../../Ainekio/Master/gateway/plugins.py): depth_demand/release callback and aclose/_finish_close | `30c4a24a0439f6b5b90db198584595796fa400d946e905086596cc8a9231c1ef` |
| [hotspot.py](../../../../Ainekio/Master/gateway/hotspot.py): start/_service/set_enabled | `e51efbbc7fe088c32c333ea74141e253afb748aee1fc538752da5c56ddc705e4` |
| [host_audio.py](../../../../Ainekio/Master/gateway/host_audio.py): stop_scan/close | `cbd97b7e6108ac2eae24a63a4701f502bf28f27c3df90259e2d25811bdd2ccba` |
| [Freestyle bridge.py](../../../../Ainekio/experiments/freestyle/bridge.py): close | `acd72869a8e1c06fbe06fdef5d660dd4e0c1cc08df55cdfa520e87aff5333f56` |
| [environment_adapter/server.py](../../../../Ainekio/Master/gateway/environment_adapter/server.py): constructor and connection-handler cleanup; close/action-task references | `32e4891f9d7818c224e4205fcc1eac2836dcb0af5613fbf1cc18732f21c9f433` |
| [action_receipts.py](../../../../Ainekio/Master/gateway/environment_adapter/action_receipts.py): constructor/connection, transaction and close | `13cd4dd0964903c65a9fb0ae112e5d1e33355f4ab673ec812ad18c403c6d87d3` |

### Unresolved questions and disagreements

| Question | Evidence and current status |
| --- | --- |
| First-file naming and review | The actual entrypoint is `server/__main__.py`; the literal `server/main.py` path is absent. Coordinator review permits documentation progression; Greg review remains pending. |
| Startup/shutdown ownership | The coordinator-reviewed gait explanation distinguishes sequential successful repeat, concurrent completion, cancellation and failed transport cleanup. Targeted sections establish HTTP admission overlap and narrow depth-release failure propagation. The entrypoint repair and isolated regressions are now authorized; the separate unresolved contracts remain outside this batch. |
| Which contents should be excluded from detailed review? | Proposed categories are Git internals, installed dependencies, generated builds/caches, model weights, recordings, logs, private runtime data and credentials. Binary CAD/media would receive ownership/reference coverage rather than textual review. Explicit approval remains pending. First-party integrations and patches inside dependency or experiment directories are not automatically excluded. |
| Should root agent instruction files be tracked? | Current root repository instructions say local-only, ignored and untracked; Maintained Surface's “Excluded and Local Areas” says they belong in version control. The disagreement is preserved; this walkthrough changes neither policy source. |
| Who owns the existing uncommitted work? | Both repositories are dirty. Historical audit assignments do not establish current editing ownership. No overlapping implementation edit is authorized. |

### Approved decisions and changes

| Decision | Authority and effect |
| --- | --- |
| Use this Robot Bible as the master document | Owner instruction, 2026-11-02: explain the robot and its functions first, with the approved system outline below. No separate master review document is created. |
| Create the initial structure and review one file | Owner instruction, 2026-11-02: documentation and the first file review only. Stop for review before advancing. Repairs require specific approval; “continue” permits the next review, not an edit. |
| Proceed with the previously proposed entrypoint review | Owner follow-up, 2026-11-02, confirms the entrypoint proposed earlier and authorizes updating this document only. The actual `__main__.py` filename is recorded explicitly. The explanation remains provisional until the owner reviews it. |
| Coordinator-directed documentation investigation | Coordinator direction, 2026-11-02: fully read the gait-learning service, focus on startup/cleanup/transport, update this Bible and return findings for challenge. Coordinator-reviewed and Greg-reviewed are distinct; no implementation, test/configuration edit, training, restart or hardware action is authorized. |
| Concentrate on a minimal repair proposal | Coordinator direction, 2026-11-02: incorporate the independent gait review, inspect only necessary dependency sections, and propose entrypoint cleanup with exact owners, limits and isolated cases. Repair Coordinator subsequently accepted the isolation/fixture details for presentation to Greg, with the existing three-file scope. At that stage, authorization covered documentation and diagnosis only. Greg's later repair authorization below governs implementation and tests; separate gait defects do not automatically enter the batch. |
| Standing repair authorization | Greg's subsequent direct instructions, reiterated in message `01a19ebc-0189-7660-9917-625c8b6e535f` and again in the coordinator terminal, authorize repairs and routine validation without repeated routine approval. The present implementation batch remains the three files above. Changes to product semantics, prompts or mechanisms, and physical/live operations or deployment retain their actual authority boundaries. This supersedes the earlier repair-approval-pending statements; it does not mark all files Greg-reviewed. | Greg's newer subtraction-first direction supersedes this general authority for net-additive production changes: those require a specific exception first; moves alone do not meet the cleanup requirement.
| Coordinator architecture qualification | The independent review accepted the teach-back in turn `01a19ebb-5ca1-7c51-bc45-e3d430165325` as a working architectural map for bounded coordination. The architecture hold is satisfied. Representative source checks are not exhaustive file review or live/physical qualification. Each different capability repair still needs its own source trace. Terminal results and successful completion remain distinct, and goal achievement requires further evidence. |

The recoverable baseline is
`/home/greggles/Documents/Codex/2026-11-02/startup-cleanup-baseline-20261103T001416Z`
(directory mode `0700`). Its staged/unstaged binary patches reconstructed both
repositories' tracked working state at verification; it also contains the three
selected original files. It is a read-time snapshot, not an atomic snapshot of
concurrent writers. Relevant ignored configuration/runtime owners are identified
without copying secrets or store contents. Untracked/ignored contents, live
databases, recordings, model weights and runtime training stores were not copied
and remain untouched. These are explicit backup limits, not evidence of their
removal or safe disposability. Do not copy secrets into this document. No
deployment, publication, firmware flashing, service restart, hardware operation,
training interruption or security change is authorized by this repair.

### Coverage index and resume checkpoint

Coverage states are **unreviewed**, **partial**, **awaiting coordinator review**,
**coordinator-reviewed / Greg review pending**, and **Greg-reviewed**. A complete
read is not reviewer approval. Inventory is separate from review. Record the repository
commit and the working file's SHA-256 when reviewing it, because a clean commit
identifier alone does not describe an uncommitted file. A later hash change
requires reconciliation; it does not inherit the old reviewed status.

The initial read-only census on 2026-11-02 found 3,995 tracked Ainekio paths and
1,965 tracked MetaHuman paths. Filesystem traversal counted 111,463 and 405,988
file entries respectively, including Git internals, dependencies and runtime
data. Directory symlinks were counted without following their targets; no
traversal access errors were reported. These are time-specific inventory counts,
not first-party-source counts or review completion. Classification is provisional.

The per-file index is not yet populated for the whole census. All unlisted files
remain unreviewed for this supervised walkthrough. An incremental index will
record repository/path, category, status, inspected revision/hash, covered
sections and the owner's response. Approved excluded categories will be recorded
without copying their contents. The stopped audit's coverage and test claims
are historical evidence, not inherited review completion.

| File or evidence | Status | Revision / extent |
| --- | --- | --- |
| `Ainekio/Master/gateway/server/main.py` | Requested path absent; no file to review | Filename correction to the existing entrypoint is documented above |
| [Ainekio server entrypoint](../../../../Ainekio/Master/gateway/server/__main__.py) | Original explanation coordinator-reviewed; Greg source review pending. The 531-line repaired candidate/task diff is independently coordinator-reviewed and accepted for this bounded repair | Ainekio HEAD `3178eabe0ed9335d222798aeff25fb5dd91af91b`; original SHA-256 `dfafaf4c2209471c68622c9dc78e8c9bae3601349604415f5faf80cf9fc069ff`; accepted startup checkpoint `1a46a7e0e1b7142b821290f9776be2f40534be9c86ab85e41726eb7642365819`; current import-only consolidation `9383a1860c982062f0064187d31429cb81dba5d70b72453792a6843eae6dd511` accepted as recorded; [explanation](#body-control-application-entrypoint) |
| [Gait-learning service](../../../../Ainekio/Master/gateway/gait_learning_service.py) | Original 792-line explanation coordinator-reviewed; close checkpoint independently accepted (two coordinator checks pass); recorder candidate parked/unaccepted; bank checkpoint independently accepted; cleanup-drain extraction locally verified and awaiting coordinator review; not Greg source-reviewed | Same Ainekio HEAD; original SHA-256 `773fa53a1472708acd8ec4b85dfb8f96c985169d9f53876b384e078c6f692cd6`; close checkpoint `9f6d43ab856d8ab51af1f9af706b06694a9c6262d0e1239ac91a09d412b23114`; relocation checkpoint `360e9369bb19c081621deaf9f681c775592fab528a514fddd41ddd8fdc0fb5e4`; parked recorder checkpoint `ebc70545dad0793d0b249ba8cefae4376e3dea039a0b948f394523b589aef0b0`; accepted 832-line bank checkpoint `d2e8f14a062539f22c0b9a33dc1c2a863cdf798729f59facbdb22e8d444a589a`; current 817-line cleanup-drain candidate `3289184ae76fcbd0c547600a0934ca74f00d48d4290da460b0ff6d29ef48a0bd`; [bank consolidation](#saved-bank-restoration-consolidation) |
| Targeted startup/shutdown dependencies | Partial; supporting sections only | Per-file symbols and hashes in [proposal evidence](#minimal-startup-cleanup-repair-proposal); no added whole-file review |
| [Gateway startup/security tests](../../../../Ainekio/Emulator/tests/test_gateway_security.py) | Accepted startup task diff reviewed; maintained module 22 tests still pass after import relocation; not Greg-reviewed | Accepted checkpoint `7f973793a6ea5212383f681554055629b3179e2c4e22686cd79ab263cebb0dd6`; current patch-target-only change `a25407f3dc7f28af545a9449bca16a02ccfc7a59e71ca2a9ec8f7bf4c9d30b08`; original is in the private baseline |
| [Gait service tests](../../../../Ainekio/Emulator/tests/test_gait_learning_service.py) | New CloseLifecycleTests/task diff reviewed; 40 selected cleanup/bank/recorder/close/depth/replacement checks pass; no whole-file or Greg review claimed | Close checkpoint `dfaf97e893e5e3e11bc6a3fa1a7f31dc71f755ea86d8bf6e032ec7e20bbbfd5a`; relocation checkpoint `8a7e5316023bee1b4c294d21fe34b4491dd8f58afab674a474cdffff40b069cc`; parked 1,674-line checkpoint `10f94a9330b91a3de4485f7b82572aa9ff4d96e2094ff6bb543769e415ab746b`; accepted bank tests `47a6b366c14e96c0514867f20db3a223231afa51955babd52e52b703f75b966c`; current 1,944-line cleanup-drain tests `2f1d155c691a59b3d3ef3d249a75340554bf49f71fea4dd4ec2ead8823fe8021`; original and partial-read ranges recorded above |
| [Task-selection domain contract](../../../packages/core/src/environment-interface/task-selection.ts) and its 23 consumers | Partial: relocation/import diff and body/export/registration preservation checked; earlier checkpoint accepted as recorded; no Greg review | Exact hashes and consumer list in private consolidation artifacts; [evidence](#task-contract-and-maintenance-transport-consolidation) |
| [Maintenance transport](../../../../Ainekio/Master/gateway/robot_learning_transport.py) and its consumers | Relocated class/exception source fully compared; consumer changes partial; earlier checkpoint accepted as recorded; not Greg-reviewed | Current SHA-256 `8e461120b6a4f974cc94955c13c2212b61e62b7b86be9436cf951f3166bbf0e2`; no whole-file review inherited for consumers |
| Supporting launcher/test excerpts cited in the first-file explanation | Partial; supporting evidence only | No full-file coverage or owner review claimed; later reviews must record their own hashes |
| Existing architecture references and repository instructions | Orientation only; not reviewed with owner | Consulted as navigation and constraints; per-file review coverage has not been established |

**Resume checkpoint:** Two implementation files have complete reads and
coordinator review for progression, with cleanup-contract corrections recorded.
Neither is Greg-reviewed. Targeted dependency inspection is complete for the
minimal startup-cleanup proposal above; no additional whole-file review began.
The proposal, including the exact isolation and pre-teardown completion proof,
is coordinator-reviewed. Greg has authorized the repair and routine validation,
and the architecture qualification hold is satisfied. The inspector remains the
sole production/test writer. The private baseline is verified. The bounded
entrypoint correction and isolated regressions are implemented: 22 owner tests
and four selected recording/depth checks pass after original failure evidence.
Native execution permission prompts completed through normal controls. The
coordinator independently reviewed and accepted that startup batch, including
repeating the original socket-failure probe; its cleanup bodies remain intact,
with transport imports updated by the subsequent consolidation.
The close checkpoint is independently accepted with two coordinator regression
checks passing at its recorded hashes. Earlier ownership-relocation acceptance
remains as recorded; neither marks files Greg-reviewed.
The recorder-release candidate remains PARKED / UNACCEPTED at its original net
+77 production lines; exact recorder and bank checkpoint artifacts are unchanged.
The bank consolidation is independently accepted at net −1, with seven independent
coordinator tests passing. The current cleanup-drain extraction removes both
wait/result bodies into one operation: +7/−22, net −15 against that 832-line bank
checkpoint; 40 focused checks pass. Task creation, configure and both finalizers
are unchanged. Current service size is 817 lines; cumulative change from the
accepted 756-line owner checkpoint is +61, including parked work, not accepted
cleanup. Coordinator review of this extraction is pending. Mutation/close work
remains deferred and net-additive repairs require Greg's specific exception.
No new whole-file/Greg review, live operation, training or hardware action is claimed.
