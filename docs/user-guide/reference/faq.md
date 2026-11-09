# Frequently Asked Questions

## Where should I start?

Follow [Installation](/user-guide#02-installation), then [Setup and Login](/user-guide#03-setup-and-login). Use `./bin/mh help` for the current CLI surface.

## Where does my data live?

Persona, profile, memory, voice, logs, and generated outputs are user/runtime data resolved through the storage system. They are not maintained source and should not be committed. See [Multi-User Profiles](/user-guide#multi-user-profiles).

## Does Ainekio OS require the cloud?

No. llama.cpp, Ollama, Whisper, Piper, Kokoro, and supported training workflows can run locally. Remote model and sync features require a configured server and network access.

## How do I check system health?

```bash
./bin/mh status
./bin/audit check
```

For a specific subsystem, use its status command, such as `./bin/mh ollama status`, or `./bin/mh kokoro status`.

## Which LLM backend should I use?

Use Ollama or llama.cpp for local serving, or a remote backend when compute is hosted elsewhere. Keep routing in the backend and model-router owners. See [LLM Backend Configuration](/user-guide#llm-backend).

## Why is a model unavailable?

Confirm the selected backend is running, the configured model identity exists there, and the active profile can read its configuration. A running provider does not prove the requested model is loaded.

## Can I use multiple users?

Yes. Profiles isolate user-owned configuration and content. Administrative actions are owner-guarded. See [Accounts and Security](/user-guide#accounts-security) and [Authentication](/user-guide#authentication).

## How does memory work?

Memory is profile-owned and accessed through the core memory/storage owners. The UI and agents should use public core exports rather than reading profile directories directly. See [Memory System](/user-guide#memory-system).

## Can Ainekio OS act autonomously?

Agents operate within explicit trust, security, and lifecycle boundaries. Enabling an agent does not bypass action authorization. See [Autonomous Agents](/user-guide#autonomous-agents) and [Security and Trust](/user-guide#security-trust).

## Can I train an AI model?

Yes. The maintained training workflow creates profile-owned artifacts through the canonical training process owner. See [AI Training](/user-guide#ai-training).

## Can I train a voice?

Piper and Kokoro speech synthesis are supported. This repository does not include custom voice model trainers. See [Voice Features](/user-guide#voice-features).

## Why did voice output fall back to Piper?

The selected provider was unavailable or lacked its required profile artifact. Check addon/service status, speaker selection, model/reference paths, and provider logs. See [Voice Features](/user-guide#voice-features).

## How do I run headless?

The current owner control records machine headless state; it does not stop or
restart agents. Inspect and control the intended services separately through
Agent Monitor or `./bin/mh agent`, as described in
[Headless Mode](/user-guide#headless-mode). Do not add a second process manager
or watcher for an existing service.

## Where should configuration changes go?

Use the relevant UI, CLI, or public core configuration owner. Root `etc` files are stable system defaults; profile settings belong to the active profile. See [Configuration Files](/user-guide#configuration-files).

## What should I include in a bug report?

Include the exact command or UI action, active subsystem, relevant error text, expected behavior, and focused logs. Separate source validation from live runtime or hardware proof.

## Where can I troubleshoot further?

Use the [Troubleshooting Guide](/user-guide#troubleshooting). Architecture contributors should also read the repository's maintained-surface and audit documents before changing ownership boundaries.
