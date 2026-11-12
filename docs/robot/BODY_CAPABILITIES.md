# Body and interactive capabilities

[Hardware](#body-identity-and-hardware) · [Motion](#motion-and-posture) · [Vision](#camera-perception-recognition-and-tracking) · [Speech](#listening-and-speaking) · [Display](#face-expressions-and-processing-feedback) · [Body events](#body-sensing-events-and-balance) · [Manual operation](#recording-maintenance-and-manual-operation)

[Start with the robot design core](ROBOT_BIBLE.md). Read the relevant subsection for motion, vision, speech, display or physical events.

Ainekio owns the body/gateway contracts. Actual advertised capabilities are the
runtime inventory; this page explains their use by the companion.

This page states the maintained capability contract. It does not report current
service state, selected weights or installed firmware. Use the linked owners for
configuration and [qualification](QUALIFICATION.md) for proof of behavior.
Dated deployments, comparisons and incidents are retained in the
reference history (retained locally).
A historical success or failure is evidence under its recorded conditions;
refresh those conditions before treating it as the present state.

## Body identity and hardware

V2 is the twelve-servo ESP32-P4/PCA9685 body; V1 is the separate eight-servo
ESP32-S3/MCPWM body. They share Body Control and the Environment adapter while
retaining different calibration, motion and joint contracts. V1 simulation
or an eight-joint motion plan does not qualify V2 execution.

Start with the dedicated [V1 specifications](../../../Ainekio/docs/v1-8servo/SPECIFICATIONS.md)
or [V2 specifications](../../../Ainekio/docs/v2-12servo/SPECIFICATIONS.md) for
hardware, dimensions, wiring and body/remote connections. Use the selected
device and its actual configuration for installed facts.
[Model boundaries](../../../Ainekio/docs/ROBOT_MODELS.md),
[V2 hardware records](../../../Ainekio/docs/v2-12servo/README.md),
[P4 firmware](../../../Ainekio/Slave/firmware/esp32p4-wifi6/README.md),
[motion geometry](../../../Ainekio/Slave/software/models/v2-12servo/README.md),
[servo assembly](../../../Ainekio/Slave/software/models/v2-12servo/SERVO_ASSEMBLY.md)
and the [resource budget](../../../Ainekio/docs/v2-12servo/RESOURCE_BUDGET.md)
own their respective details. Commanded pose and modeled ground contact are
not physical measurements. Geometric zero, Home, Stand, Sit and Rest differ.

CAD, motion-authoring tools and the [emulator](../../../Ainekio/Emulator/README.md)
support development; simulation does not establish loaded tracking, balance,
traction or real-world distance.

## Physical and interactive abilities

### Motion and posture

Body Control's Freestyle owner handles MetaHuman `requestMotion.description`,
startup/wake and stall correction requests. The manual **Poses and emotes →
Default motion system** selector affects explicit manual controls; it does not
redirect these semantic requests to the legacy Motion Library. Freestyle uses
the configured generator and asynchronous executor, then the gateway/P4 target
execution path. A Freestyle job ID records submission, not successful generation
or physical completion. An unavailable generator is reported without substituting
a library movement. Stop, camera and display remain independent.

Freestyle exposes native Stand as `[["stand"]]`. That program operation invokes
the installed P4 Stand controller, including startup rise, grounded posture
transitions and feedback correction. The model selects this operation; the
library's Stand examples use the same operation directly.

Inactivity rest/release is body-local: the existing configurable timer defaults
to three minutes, plays the built-in Lay Down and releases outputs after it
finishes. The custom-movement curriculum does not teach servo-output release.
A stall goes to Freestyle for correction. If that correction stalls, the new
evidence returns to the same model owner for another assessment while outputs
remain powered. There is no second-stall release or code-selected retry limit.
Explicit Stop and Release retain their existing contracts. A stall notification
does not itself trigger a help reply. Installed firmware, gateway and adapter
versions determine which recorded contract is active.

The revised Freestyle contract executes a complete generated program once;
normal completion does not request another model assessment. Event recovery
retains the original interrupted request and its unfinished phases across
successive corrections. Training labels adapt the approach and then complete
that requested movement, preserving its holds and terminal pose; standing is
not the default recovery goal. Measured arrival remains owned by P4; actual
body-fault events retain the existing recovery path. See Freestyle's deployment evidence before
assuming that revised source or training labels are active on an installation.

The native library and low-level controls retain their explicit manual contracts.
MetaHuman's Task model coordinates actions and observations while Body Control
owns joint-program generation. See the [software execution path](SYSTEM_ARCHITECTURE.md#a-request-to-move),
[`GatewayService.request_motion`](../../../Ainekio/Master/gateway/server/service.py)
and [Freestyle owner](../../../Ainekio/experiments/freestyle/README.md).

Capability code includes postures (Stand, Sit, Neutral, Rest, Lie Down, Crouch, experimental Upright), gestures (Wave, Bow, Nod, Pushup, Point, Dance and others), and V2 locomotion (Walk, Run, Crawl, Crab and ongoing steering). Use [semantic translation](../../../Ainekio/Master/gateway/environment_adapter/translation.py) and actual advertised capabilities rather than a second runtime catalog.

The V2 body owns continuous gait execution, finite gesture trajectories, steering, and per-device calibrated output. Speed, stride/rate, direction, and finite gait-cycle count are distinct controls whose ranges come from the selected body's advertised contract. Commanded joint pose is not measured shaft position, and modeled planted feet are not measured ground contact. P4 [controller source](../../../Ainekio/Slave/firmware/esp32p4-wifi6/main/controller.c) distinguishes **ordinary Stop** (cancel motion and hold the commanded pose with outputs enabled; also cancels affected audio/snapshot work), **detach** (disable outputs), and **gait Finish** (complete the gait's stopping transition, requested by speed zero).

**Goal-directed locomotion:**
- MetaHuman selects a locomotion goal together with gait controls rather than exposing bare Walk, Run, Turn, Crab or Crawl starts. The goal specifies a measured distance, signed relative turn, approach relationship, ongoing follow relationship with an ending condition, or visual endpoint. Gait percentage controls express actuation (not m/s), and finite gait-cycle counts or elapsed time are not arrival evidence. Standing, resting and finite gestures use ordinary command handling, and manual Body Control gait primitives remain available through their existing owner.
- Core Active Task owns execution and progress; Bridge carries sensor evidence and the movement's start/update/Finish receipts. Visual and follow goals reuse the behavior evaluator and its selected observation cadence so sensor updates wake the active execution without another intention or task-selection call. Results distinguish endpoint evidence, requested Finish, acknowledged settings, and the gait's terminal receipt.
- **Missing-measurement behavior:** If a goal's required measurement is unavailable before movement, report incomplete without starting; if it becomes unavailable during movement, request Finish on that gait and retain the actual outcome for the planner without substituting timed travel, a new target or an automatic restart. Camera, orientation and target measurements have independent availability, and the four-second gateway control-freshness interval expires orientation telemetry if that stream stops.
- **Measurement contract:** Metric image estimates require real camera intrinsics, a measured camera-to-body transform and an explicit ground-contact point in retained image evidence (an image-box fraction is not a metric distance, and a box bottom is not assumed to touch the floor). Signed lateral control belongs to the P4 movement, protocol and Core goal-control owners; a measured Crab goal without advertised lateral-control reports incomplete before starting. Steering updates do not overwrite requested gait speed. Visual-only goals use independent camera availability and source expiry without requiring YOLO or metric calibration.

### Camera, perception, recognition, and tracking

- **On-demand depth lifecycle:** Body Control's camera owner processes depth only for active consumers. Core's navigation executor requests it for measured-distance and metric approach/follow goals via the camera-read bridge (`operation: "depthDemand"`, `consumerId`, `enabled`); active gait recording and explicit single-sample dashboard requests share that owner. Ordinary conversation, photos and video streaming do not load the depth model. Consumers release demand on completion, failure, cancellation or bridge disconnect (reconnect restores demand for ongoing executions), and the last release unloads the model.
- **Acquisition and exposure:** P4 shares one camera acquisition/JPEG pipeline across preview streaming and correlated still captures (including wake-speech capture correlation). Body Control displays frames and runs configured perception on its camera worker without blocking the robot receive loop. Reading the latest cached image reuses its original identity and time; an explicit capture produces a new correlated still. Exposure stability belongs to the running sensor (preview measurements can serve later snapshots; sensor restart or mode/exposure changes require fresh evidence). An explicitly disconnected body retains its projected camera availability in Bridge Input rather than being overwritten by historical telemetry.
- **Recognition and provenance:** Camera evidence carries recognition results in image metadata (robot ID, gateway instance, connection epoch, frame counter, receipt time). Camera reads return the latest analyzed JPEG/result pair when recognition is enabled, or the raw image otherwise; requested snapshots join that exact frame's analysis on the camera worker before delivery. Autonomy passes the selected image and metadata together to Robot Status, which stores frame provenance and recognition under `recordedSituation` without embedding image bytes in its JSON snapshot.
- **Visual behaviors:** YOLOE provides Body Control object detection and visual prompting. For an ongoing `behavior` step with its own target, motion and `completionCriteria`, the [active-task owner](../../packages/core/src/nodes/environment/active-task.node.ts) evaluates supplied visual evidence, requests gait Finish when criteria are met, and advances only after the correlated terminal receipt. See [camera source](../../../Ainekio/Slave/firmware/esp32p4-wifi6/components/ainekio_p4_media/camera.c), [Body Control perception](../../../Ainekio/Master/gateway/README.md#continuous-camera-processing), and [named-person recognition](../../../Ainekio/Master/gateway/README.md#named-people-optional-local-models).

### Listening and speaking

Body firmware supports microphone capture with Open, VAD and wake-word modes, saved gain/settings, and audio transport to MetaHuman's STT owner. Speaker playback and listening interact through firmware's capture/playback rules.

MetaHuman's audio control selects **Off / Browser / Body Control** for all workflows with a TTS Output node (including Inner Dialogue). Off prevents new speech admission; Browser plays in the browser; Body Control routes to the selected robot session and the gateway's configured destination (**Robot speaker** or **Body Control computer**). Speech admission is independent of movement and preserves chunk order. See [speech destinations](../../../Ainekio/Master/gateway/README.md#speech-destination) and [voice/TTS ownership](../technical/MAINTAINED_SURFACE.md).

### Face expressions and processing feedback

The body display presents expressions used by motions and standalone face selection through replacement and timeout/release behavior: listening during recording (plus a small P4 shoulder cue in the [firmware reference](../../../Ainekio/Slave/firmware/esp32p4-wifi6/README.md)), animated thinking while transcribing/reasoning, speech or motion expressions during activity, normal face at completion, and error/connection indications when applicable.

### Body sensing, events, and balance

P4 acquires IMU data, estimates attitude, publishes timestamped telemetry, and runs V2 balance corrections. Servo-feedback fault/restoration reports serve telemetry and Freestyle recovery without directly invoking a conversational workflow.

Body Control detects configured event episodes (tilt, rapid movement, motor stall, boot/wake) and forwards measurements to Core's event router:
- **Robot Wake-Up:** Reported `wake` events combine a wake event and fresh camera image from Body Control while Body Control dispatches local stretch (including return to standing). The wake-up graph supplies the event, active persona, image and dated body status to one Persona greeting concurrently with stretching, publishing directly through Conversation Buffer, Save Conversation Memory, Conversation Output and TTS Output without creating a goal or invoking Environment Mode.
- **Fast Body Event ([`fast-body-event-mode.json`](../../etc/cognitive-graphs/fast-body-event-mode.json)):** Handles `tipped`, `rapid_movement` and `servo_stall` events without Intent, Task, Planner, persona or memory context:
  - Sends an attributed `be_` foreground display token (`confused` for tipping, `surprised` for rapid movement; P4 foreground and background expression slots remain separate, and Body Control suppresses repeat shake/tip episodes while the `be_` token or configured cooldown is active).
  - Selects the editable **Tipping Prompt** or **Rapid Movement Prompt** (passing the event kind and bounded recent Fast Body Event speech reactions from durable execution state to the `lightweight` model role at broader sampling for one short remark—dry wit, surprise, mild unease, or self-directed dark humor—varied from recent reactions without insults, blame or orders) or **Motor Stall Prompt** (additionally passing gateway-reported joint IDs/names, reason and output-release state to ask briefly and gently for help).
  - Publishes the remark to the live conversation stream only (not saved to conversation buffers, memory or training data) and speaks it through the originating robot session.
  - **Reset Event Expression** releases the `be_` display token after feed publication and correlated robot speech playback receipts complete (or after admission for local computer audio / 60-second robot-local expiry).
- **Other Body Events ([`body-event-trigger-mode.json`](../../etc/cognitive-graphs/body-event-trigger-mode.json)):** Interprets remaining events and may choose `decision: none` (`instruction: null`) or delegate a nonempty instruction to Environment Mode. Plain telemetry updates status without starting a cognitive request. See [body events](../../../Ainekio/Master/gateway/README.md#v2-body-events-and-imu-status) and [P4 body owner](../../../Ainekio/Slave/firmware/esp32p4-wifi6/main/body.c).

### Recording, maintenance, and manual operation

Body Control provides manual motion controls, calibration, camera/recognition settings, audio settings, networking/pairing, body event settings, status and diagnostics. Firmware supports SD video recording alongside preview, clip listing/download, rolling clip reuse, and P4 application OTA upload/activation and log retrieval. See [recording and OTA](../../../Ainekio/Slave/firmware/esp32p4-wifi6/RECORDING_OTA.md) and [Body Control workspace](../../../Ainekio/Master/gateway/README.md#body-control-workspace).
