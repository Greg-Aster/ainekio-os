import { MODEL_ROLE_OPTIONS, type ModelRole } from '@metahuman/core/model-roles';

export interface ModelInventoryEntry {
  id: string;
  aliases?: string[];
  model: string;
  provider: string;
  roles?: string[];
  capabilities?: string[];
  description?: string;
  adapters?: string[];
  baseModel?: string | null;
  metadata?: Record<string, any>;
  options?: Record<string, any>;
  source?: string;
  locked?: boolean;
}

export interface BaseModelChoice {
  key: string;
  model: string;
  label: string;
  provider: string;
  endpoint: string;
  base: ModelInventoryEntry;
  registeredBase: boolean;
  adapters: ModelInventoryEntry[];
  members: ModelInventoryEntry[];
}

function hasAdapter(model: ModelInventoryEntry): boolean {
  return Boolean(model.adapters?.length || model.options?.lora?.length
    || model.metadata?.isLora);
}

function baseIdentity(model: ModelInventoryEntry): string {
  const name = hasAdapter(model) && model.provider !== 'llama-cpp'
    ? model.baseModel || model.model : model.model;
  return JSON.stringify([
    model.provider,
    name,
    model.options?.endpoint || '',
    model.provider === 'big-brother' ? model.id : '',
  ]);
}

function adapterIdentity(model: ModelInventoryEntry): string {
  return JSON.stringify([model.model, model.adapters || [], model.options?.lora || []]);
}

/** The existing assignment IDs remain authoritative; grouping is display only. */
export function buildBaseModelChoices(models: ModelInventoryEntry[]): BaseModelChoice[] {
  const choices = new Map<string, BaseModelChoice>();
  for (const model of models) {
    const key = baseIdentity(model);
    let choice = choices.get(key);
    if (!choice) {
      const name = hasAdapter(model) && model.provider !== 'llama-cpp'
        ? model.baseModel || model.model : model.model;
      const label = model.provider === 'big-brother' && model.baseModel
        ? `${model.baseModel} (${name})`
        : (model.baseModel?.split('/').pop() || name);
      choice = {
        key, model: name, label,
        provider: model.provider, endpoint: model.options?.endpoint || '',
        base: hasAdapter(model) ? {
          id: `${model.provider}.${name}`, provider: model.provider, model: name,
          roles: [], capabilities: model.capabilities || [], adapters: [],
          description: name, options: { ...model.options, lora: [] },
        } : model,
        registeredBase: !hasAdapter(model), adapters: [], members: [],
      };
      choices.set(key, choice);
    }
    if (choice.label === choice.model && model.baseModel) choice.label = model.baseModel.split('/').pop() || choice.label;
    choice.members.push(model);
    if (!hasAdapter(model)) {
      if (!choice.registeredBase || model.id === `${model.provider}.${model.model}`) choice.base = model;
      choice.registeredBase = true;
    } else {
      if (!choice.adapters.some(adapter => adapterIdentity(adapter) === adapterIdentity(model))) choice.adapters.push(model);
    }
  }
  for (const choice of choices.values()) {
    if (!choice.registeredBase) choice.base.capabilities = [...new Set(
      choice.members.flatMap(model => model.capabilities || []),
    )];
  }
  return [...choices.values()];
}

export function modelChoiceForAssignment(choices: BaseModelChoice[], modelId: string): BaseModelChoice | undefined {
  return choices.find(choice => choice.members.some(model => model.id === modelId || model.aliases?.includes(modelId)));
}

export function adapterChoiceForAssignment(choice: BaseModelChoice, modelId: string): ModelInventoryEntry | undefined {
  const member = choice.members.find(model => model.id === modelId || model.aliases?.includes(modelId));
  if (!member || !hasAdapter(member)) return undefined;
  return choice.adapters.find(adapter => adapterIdentity(adapter) === adapterIdentity(member));
}

export function modelAdapterLabel(model: ModelInventoryEntry): string {
  return model.metadata?.run || model.description || model.adapters?.join(', ') || model.model;
}

export interface WorkflowModelSummary {
  key: string;
  name: string;
  error?: string;
  models: Array<{
    nodeId: string;
    label: string;
    role: string;
    selection: string;
    error?: string;
  }>;
}

export interface ModelRolePresentation {
  role: ModelRole;
  label: string;
  description: string;
}

/** One editable row per saved role, with usage from the configured graphs. */
export function buildModelRoleSections(workflows: WorkflowModelSummary[], mode: string) {
  const workflow = workflows.find(item => item.key === mode);
  const primaryRoles = new Set(workflow?.models
    .filter(binding => binding.selection === 'role').map(binding => binding.role));
  const roles: ModelRolePresentation[] = MODEL_ROLE_OPTIONS.map(({ value, label, description }) => {
    const usage = workflows.flatMap(item => item.models
      .filter(binding => binding.role === value && binding.selection === 'role')
      .map(binding => `${item.name}: ${binding.label}`));
    return {
      role: value,
      label,
      description: [
        description,
        ...new Set(usage),
      ].join('\n'),
    };
  });
  return [
    {
      label: workflow?.name || 'Workflow roles',
      description: 'Roles selected by this workflow. Hover over a role to see its node usage.',
      roles: [...primaryRoles].flatMap(role => roles.filter(item => item.role === role)),
    },
    {
      label: 'Other saved roles',
      description: 'Assignments for other nodes and workflows in this mode.',
      roles: roles.filter(item => !primaryRoles.has(item.role)),
    },
  ].filter(section => section.roles.length > 0);
}
