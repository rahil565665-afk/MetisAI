export type UserRole = 'platform_admin' | 'owner' | 'manager' | 'viewer';

export interface AppUser {
  id: string;
  email: string;
  display_name: string;
  is_platform_admin: boolean;
  is_active: boolean;
}

/** Whether a clinic's voice agent may take calls: 'live' once it has stored credentials. */
export type AgentStatus = 'not_created' | 'live' | 'failed';

export interface IntegrationState {
  configured: boolean;
  updatedAt?: string;
  note?: string;
  /** Set when the credentials were saved but a check showed they do not work yet, with what to fix. */
  problem?: string;
}

export interface ReceptionistConfig {
  greeting?: string;
  faqs?: Array<{ question: string; answer: string }>;
  transfer_enabled?: boolean;
  [key: string]: unknown;
}

/** A clinic as kept in the console's registry. Call history lives in the clinic's own database. */
export interface Company {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  is_active: boolean;
  timezone: string;
  receptionist_config: ReceptionistConfig;
  agent_status: AgentStatus;
  integration_status: Record<string, IntegrationState>;
  created_at: string;
  updated_at: string;
}
