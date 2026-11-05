export interface CalendarSelector {
  event_type_id?: number | null;
  event_type_slug?: string | null;
  username?: string | null;
  team_slug?: string | null;
}

export interface IntegrationStatus {
  configured: boolean;
  updatedAt?: string;
  note?: string;
}

export interface Company {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  is_active: boolean;
  timezone: string;
  agent_status?: 'not_created' | 'live' | 'failed';
  integration_status?: Record<string, IntegrationStatus>;
  receptionist_config: {
    greeting?: string;
    knowledge_base?: string;
    faqs?: Array<{ question: string; answer: string }>;
    transfer_enabled?: boolean;
    calcom?: CalendarSelector;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'transfer_requested' | 'disconnected' | 'error';
