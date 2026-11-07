import type { CalComSelector } from './calcom.js';
import { cleanKnowledgeText } from '../../server/integrations/knowledge.js';

/** Non-secret clinic settings the receptionist needs, normalised from the stored `receptionist_config`. */
export interface ClinicConfig {
  tenantId: string;
  clinicName: string;
  timezone: string;
  greeting: string;
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

export function normalizeClinicConfig(company: { id: string; name: string; timezone?: string | null; receptionist_config?: unknown }): ClinicConfig {
  const raw = record(company.receptionist_config);
  const calcom = record(raw.calcom);
  const faqs: ClinicConfig['faqs'] = [];
  if (Array.isArray(raw.faqs)) {
    for (const item of raw.faqs.slice(0, 50)) {
      const entry = record(item);
      const question = text(entry.question, 300);
      const answer = text(entry.answer, 2000);
      if (question && answer) faqs.push({ question, answer });
    }
  }
  return {
    tenantId: company.id,
    clinicName: text(company.name, 120),
    timezone: text(company.timezone, 80) || 'UTC',
    greeting: text(raw.greeting, 800),
    knowledge: cleanKnowledgeText(raw.knowledge_base),
    faqs,
    calcom: {
      event_type_id: calcom.event_type_id,
      event_type_slug: text(calcom.event_type_slug, 120) || null,
      username: text(calcom.username, 120) || null,
      team_slug: text(calcom.team_slug, 120) || null,
    },
  };
}
