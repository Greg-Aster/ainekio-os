/**
 * Card System Type Definitions
 * Shared interfaces for message card components
 */

import type { ChatMessage } from '../../lib/client/composables/useMessages';

// Card component identifiers
export type CardComponent =
  | 'UserMessageCard'
  | 'AssistantMessageCard'
  | 'ReflectionCard'
  | 'DreamCard'
  | 'CuriosityCard'
  | 'ReasoningCard'
  | 'SystemMessageCard';

// Base props all cards receive
export interface BaseCardProps {
  message: ChatMessage;
  index: number;
  isSelected: boolean;
}

// Goal label configuration by type
export interface GoalLabelConfig {
  label: string;
  icon: string;
}
