export type UserRole = 'platform_admin' | 'owner' | 'manager' | 'viewer';

export interface AppUser {
  id: string;
  email: string;
  display_name: string;
  is_platform_admin: boolean;
  is_active: boolean;
}

export interface Company {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  is_active: boolean;
  timezone: string;
  receptionist_config: {
    greeting?: string;
    voice_output_mode?: 'native' | 'cartesia';
    faqs?: Array<{ question: string; answer: string }>;
    transfer_enabled?: boolean;
    [key: string]: unknown;
  };
  created_at?: string;
}
