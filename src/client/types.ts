export interface Company {
  id: string;
  slug: string;
  name: string;
  render_service_id?: string | null;
  render_service_url?: string | null;
  render_deployment_status?: 'not_created' | 'creating' | 'building' | 'live' | 'failed' | 'suspended' | null;
  render_last_deploy_id?: string | null;
  render_last_deploy_at?: string | null;
  business_type: string;
  is_active: boolean;
  timezone: string;
  receptionist_config: { greeting?: string; knowledge_base?: string; faqs?: Array<{ question: string; answer: string }>; transfer_enabled?: boolean };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface IntegrationStatus {
  configured: boolean;
  metadata?: Record<string, unknown>;
}

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'transfer_requested' | 'disconnected' | 'error';
