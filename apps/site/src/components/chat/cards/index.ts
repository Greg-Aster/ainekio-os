// Component map for dynamic rendering
import UserMessageCard from './UserMessageCard.svelte';
import AssistantMessageCard from './AssistantMessageCard.svelte';
import ReflectionCard from './ReflectionCard.svelte';
import DreamCard from './DreamCard.svelte';
import CuriosityCard from './CuriosityCard.svelte';
import ReasoningCard from './ReasoningCard.svelte';
import SystemMessageCard from './SystemMessageCard.svelte';

import type { Component } from 'svelte';
import type { BaseCardProps, CardComponent } from '../card-types';

// Svelte checks the native component signature; Astro projects framework
// components as props-only functions. Both must accept the same card props.
type CardRenderer = Component<BaseCardProps> | ((props: BaseCardProps) => unknown);

export const cardComponents = {
  UserMessageCard,
  AssistantMessageCard,
  ReflectionCard,
  DreamCard,
  CuriosityCard,
  ReasoningCard,
  SystemMessageCard,
} satisfies Record<CardComponent, CardRenderer>;
