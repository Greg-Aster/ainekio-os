import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import {
  audit,
  detectAvailableBackends,
  ensureBackendRunning,
  startAssignedModelServices,
  getCurrentlyActiveUser,
  getUserContext,
  loadBackendConfig,
  ollama,
  switchBackend,
  systemPaths,
} from '@metahuman/core'

export async function ollamaCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    console.error('Usage: mh ollama <subcommand> [args]');
    console.error('\nSubcommands:');
    console.error('  status              Check if Ollama is running');
    console.error('  list                List installed models');
    console.error('  pull <model>        Install a model');
    console.error('  delete <model>      Remove a model');
    console.error('  info <model>        Show model details');
    console.error('  chat <model>        Interactive chat session');
    console.error('  ask <model> "text"  One-shot question');
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'status': {
        const running = await ollama.isRunning();
        if (running) {
          const ver = await ollama.version();
          console.log(`✓ Ollama is running (v${ver.version})`);
          console.log(`  Endpoint: http://localhost:11434`);
        } else {
          console.log('✗ Ollama is not running');
          console.log('  Start with: ollama serve');
        }
        break;
      }

      case 'list': {
        const models = await ollama.listModels();
        if (models.length === 0) {
          console.log('No models installed');
          console.log('\nInstall a model with: mh ollama pull phi3:mini');
        } else {
          console.log(`Installed Models (${models.length}):\n`);
          models.forEach(m => {
            const size = (m.size / 1e9).toFixed(2);
            console.log(`  ${m.name}`);
            console.log(`    Size: ${size} GB`);
            console.log(`    Modified: ${new Date(m.modified_at).toLocaleString()}`);
            if (m.details) {
              console.log(`    Family: ${m.details.family}`);
              console.log(`    Parameters: ${m.details.parameter_size}`);
            }
            console.log('');
          });
        }
        break;
      }

      case 'pull': {
        const modelName = args[1];
        if (!modelName) {
          console.error('Usage: mh ollama pull <model-name>');
          console.error('Example: mh ollama pull phi3:mini');
          process.exit(1);
        }

        console.log(`Pulling model: ${modelName}...`);
        await ollama.pullModel(modelName, (status) => {
          process.stdout.write(`\r${status}              `);
        });
        console.log(`\n✓ Model ${modelName} installed`);
        break;
      }

      case 'delete': {
        const modelName = args[1];
        if (!modelName) {
          console.error('Usage: mh ollama delete <model-name>');
          process.exit(1);
        }

        console.log(`Deleting model: ${modelName}...`);
        await ollama.deleteModel(modelName);
        console.log(`✓ Model ${modelName} deleted`);
        break;
      }

      case 'info': {
        const modelName = args[1];
        if (!modelName) {
          console.error('Usage: mh ollama info <model-name>');
          process.exit(1);
        }

        const info = await ollama.showModel(modelName);
        console.log(`Model: ${modelName}\n`);
        console.log(JSON.stringify(info, null, 2));
        break;
      }

      case 'chat': {
        const modelName = args[1];
        if (!modelName) {
          console.error('Usage: mh ollama chat <model-name>');
          console.error('Example: mh ollama chat phi3:mini');
          process.exit(1);
        }

        console.log(`Starting chat with ${modelName}...`);
        console.log('Type "exit" or "quit" to end the session.\n');

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

        const chat = async () => {
          rl.question('You: ', async (input: string) => {
            if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
              console.log('Goodbye!');
              rl.close();
              return;
            }

            messages.push({ role: 'user', content: input });

            try {
              const response = await ollama.chat(modelName, messages);
              console.log(`\n${modelName}: ${response.message.content}\n`);
              messages.push({ role: 'assistant', content: response.message.content });

              // Audit the chat
              audit({
                level: 'info',
                category: 'action',
                event: 'ollama_chat',
                details: { model: modelName, messageCount: messages.length },
                actor: 'human',
              });

              chat();
            } catch (error) {
              console.error(`Error: ${(error as Error).message}`);
              chat();
            }
          });
        };

        chat();
        break;
      }

      case 'ask': {
        const modelName = args[1];
        const question = args.slice(2).join(' ');

        if (!modelName || !question) {
          console.error('Usage: mh ollama ask <model> "your question"');
          console.error('Example: mh ollama ask phi3:mini "What is TypeScript?"');
          process.exit(1);
        }

        console.log(`Asking ${modelName}...\n`);
        const response = await ollama.generate(modelName, question);
        console.log(response.response);

        // Audit the query
        audit({
          level: 'info',
          category: 'action',
          event: 'ollama_ask',
          details: { model: modelName, questionLength: question.length },
          actor: 'human',
        });
        break;
      }

      case 'doctor': {
        try {
          console.log('Ollama diagnostics:\n');
          const running = await ollama.isRunning();
          console.log(`- Running: ${running ? 'yes' : 'no'}`);
          if (!running) {
            console.log('  Start with: ollama serve');
            process.exit(1);
          }
          const ver = await ollama.version();
          console.log(`- Version: ${ver.version}`);
          const models = await ollama.listModels();
          console.log(`- Installed models: ${models.map(m => m.name).join(', ') || '(none)'}`);

          // Load preferred chat model from etc/models.json if present
          const modelsCfg = path.join(systemPaths.root, 'etc', 'models.json');
          let preferred = 'phi3:mini';
          if (fs.existsSync(modelsCfg)) {
            try {
              const registry = JSON.parse(fs.readFileSync(modelsCfg, 'utf8'));
              const fallbackId = registry.defaults?.fallback || 'default.fallback';
              const fallbackModel = registry.models?.[fallbackId];
              preferred = fallbackModel?.model || 'phi3:mini';
            } catch {}
          }
          const embedModel = 'nomic-embed-text';

          console.log(`- Preferred chat model: ${preferred}`);
          console.log(`- Embedding model: ${embedModel}`);

          const hasPreferred = models.some((m: any) => m.name === preferred);
          const hasEmbed = models.some((m: any) => m.name === embedModel);
          if (!hasPreferred) console.log(`  WARN: Chat model not installed. Install: mh ollama pull ${preferred}`);
          if (!hasEmbed) console.log(`  WARN: Embedding model not installed. Install: mh ollama pull ${embedModel}`);

          // Smoke test chat
          try {
            const resp = await ollama.generate(preferred, 'Say "ok".', { temperature: 0 });
            console.log(`- Chat test: ok (${Math.min(resp.response.length, 20)} chars)`);
          } catch (e) {
            console.log(`- Chat test: FAILED (${(e as Error).message})`);
          }

          // Smoke test embeddings
          try {
            const emb = await ollama.embeddings(embedModel, 'hello world');
            console.log(`- Embeddings test: ok (dim=${emb.embedding.length})`);
          } catch (e) {
            console.log(`- Embeddings test: FAILED (${(e as Error).message})`);
          }
        } catch (e) {
          console.error('Doctor failed:', (e as Error).message);
          process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error('Run: mh ollama (without args) for help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

export async function backendCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || '';

  if (!subcommand) {
    console.log(`
LLM Backend Management — Configure local inference
========================================================

Usage: mh backend <subcommand> [options]

Subcommands:
  status              Show current backend status and configuration
  start               Start the configured backend
  switch <backend>    Switch to a different backend (ollama|llama-cpp)
  detect              Detect available backends on the system

Examples:
  mh backend status
  mh backend start
  mh backend switch ollama
  mh backend switch llama-cpp
  mh backend detect
`);
    return;
  }

  try {
    switch (subcommand) {
      case 'status': {
        const available = await detectAvailableBackends();
        const config = loadBackendConfig();

        console.log(`\nLLM Backend Status`);
        console.log(`==================`);
        console.log(`Active Backend: ${config.activeBackend.toUpperCase()}`);
        if (available.llamaCpp.configured) {
          console.log(`\nllama.cpp: ${available.llamaCpp.running ? 'Running' : 'Offline'} at ${config.llamaCpp.endpoint}`);
          console.log(`  - Model: ${config.llamaCpp.model}`);
          if (available.llamaCpp.error) console.log(`  - ${available.llamaCpp.error}`);
        }

        console.log(`\nOllama:`);
        console.log(`  - Status: ${available.ollama.running ? '✅ Running' : available.ollama.installed ? '⚪ Stopped' : '❌ Not installed'}`);
        console.log(`  - Endpoint: ${config.ollama.endpoint}`);
        if (available.ollama.model) {
          console.log(`  - Model: ${available.ollama.model}`);
        }
        if (config.activeBackend === 'ollama') {
          console.log(`  - [ACTIVE]`);
        }

        break;
      }

      case 'start': {
        if (args.includes('--assigned')) {
          const username = getUserContext()?.username || getCurrentlyActiveUser()?.username;
          if (!username) throw new Error('Authenticate and unlock a profile before starting its assigned model services');
          await startAssignedModelServices(username);
          console.log('Started model services selected in Status for ' + username);
          break;
        }
        const config = loadBackendConfig();
        console.log(`Starting configured backend: ${config.activeBackend}...`);
        const result = await ensureBackendRunning({
          forceStart: true,
        });

        if (!result.running) {
          console.error(`❌ Failed to start ${config.activeBackend}: ${result.error || 'unknown error'}`);
          process.exit(1);
        }

        console.log(`✅ Configured backend is running: ${config.activeBackend}`);
        break;
      }

      case 'switch': {
        const backend = args[1] as 'ollama' | 'llama-cpp';
        if (!backend || !['ollama', 'llama-cpp'].includes(backend)) {
          console.error('Usage: mh backend switch <ollama|llama-cpp>');
          process.exit(1);
        }

        console.log(`Switching to ${backend}...`);
        const result = await switchBackend(backend, { actor: 'cli' });

        if (result.success) {
          console.log(`✅ Switched to ${backend}`);
        } else {
          console.error(`❌ Failed to switch: ${result.error}`);
          process.exit(1);
        }
        break;
      }

      case 'detect': {
        console.log('Detecting available backends...');
        const available = await detectAvailableBackends();

        console.log(`\nAvailable Backends:`);
        console.log(`  llama.cpp: ${available.llamaCpp.running ? 'Running' : available.llamaCpp.configured ? 'Offline' : 'Not configured'}`);
        if (available.llamaCpp.model) console.log(`    - Model: ${available.llamaCpp.model}`);
        console.log(`  Ollama: ${available.ollama.installed ? '✅ Available' : '❌ Not available'}`);
        if (available.ollama.installed) {
          console.log(`    - Running: ${available.ollama.running ? 'Yes' : 'No'}`);
          if (available.ollama.model) {
            console.log(`    - Model: ${available.ollama.model}`);
          }
        }

        break;
      }

      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error('Run: mh backend (without args) for help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
