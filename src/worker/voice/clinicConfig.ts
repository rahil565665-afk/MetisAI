import type { CalComSelector } from './calcom.js';
import { cleanKnowledgeText } from '../../server/integrations/knowledge.js';
import { defaultActions, getBusinessTemplate, type BusinessTemplateId, type EnabledActions } from '../../shared/businessTemplates.js';

/** Non-secret business settings the receptionist needs, normalized from durable registry data. */
export interface ClinicConfig {
  tenantId: string;
  businessName: string;
  businessType: BusinessTemplateId;
  timezone: string;
  greeting: string;
  personaName: string;
  tone: string;
  services: string[];
  openingHours: string;
  safetyRules: string;
  bookingLanguage: string;
  enabledActions: EnabledActions;
  knowledge: string;
  faqs: Array<{ question: string; answer: string }>;
  calcom: CalComSelector;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  // Reject control characters other than newline, tab and carriage return.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cleaned)) return '';
  return cleaned.slice(0, limit);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.slice(0, 40).map((item) => text(item, 120)).filter(Boolean);
}

function resolveGreeting(value: string, businessName: string, personaName: string): string {
  return value.replaceAll('{{business_name}}', businessName).replaceAll('{{persona_name}}', personaName).slice(0, 800);
}

export function normalizeClinicConfig(company: { id: string; name: string; business_type?: string | null; timezone?: string | null; receptionist_config?: unknown }): ClinicConfig {
  const raw = record(company.receptionist_config);
  const template = getBusinessTemplate(company.business_type);
  const calcom = record(raw.calcom);
  const defaults = defaultActions();
  const storedActions = record(raw.enabled_actions);
  const enabledActions: EnabledActions = {
    booking: typeof storedActions.booking === 'boolean' ? storedActions.booking : defaults.booking,
    take_messages: typeof storedActions.take_messages === 'boolean' ? storedActions.take_messages : defaults.take_messages,
    hand_off: typeof storedActions.hand_off === 'boolean'
      ? storedActions.hand_off
      : typeof raw.transfer_enabled === 'boolean' ? raw.transfer_enabled : defaults.hand_off,
  };
  const faqs: ClinicConfig['faqs'] = [];
  if (Array.isArray(raw.faqs)) {
    for (const item of raw.faqs.slice(0, 50)) {
      const entry = record(item);
      const question = text(entry.question, 300);
      const answer = text(entry.answer, 2000);
      if (question && answer) faqs.push({ question, answer });
    }
  }
  const businessName = text(company.name, 120) || 'the business';
  const personaName = text(raw.persona_name, 80) || template.personaName;
  const greeting = text(raw.greeting, 800) || template.greeting;
  return {
    tenantId: company.id,
    businessName,
    businessType: template.id,
    timezone: text(company.timezone, 80) || 'UTC',
    greeting: resolveGreeting(greeting, businessName, personaName),
    personaName,
    tone: text(raw.tone, 500) || template.tone,
    services: stringList(raw.services, template.services),
    openingHours: text(raw.opening_hours, 1200) || template.openingHours,
    safetyRules: text(raw.safety_rules, 3000) || template.safetyRules,
    bookingLanguage: text(raw.booking_language, 1000) || template.bookingLanguage,
    enabledActions,
    knowledge: cleanKnowledgeText(raw.knowledge_base),
    faqs: Array.isArray(raw.faqs) ? faqs : template.faqs.map((faq) => ({ ...faq })),
    calcom: {
      event_type_id: calcom.event_type_id,
      event_type_slug: text(calcom.event_type_slug, 120) || null,
      username: text(calcom.username, 120) || null,
      team_slug: text(calcom.team_slug, 120) || null,
    },
  };
}
