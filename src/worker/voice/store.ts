import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createCallLog,
  recordAppointment,
  recordReschedule,
  updateAgentCallLog,
  updateAppointmentStatus,
} from '../../server/integrations/clinicDatabase.js';
import type { CallStore } from './receptionist.js';

/**
 * Call and appointment persistence for one clinic, written to that clinic's own Supabase project.
 * Everything is best effort: a database problem must never drop a live call, so failures are
 * logged by class only (never with provider messages) and reported to the caller as `false`/`null`.
 * A clinic with no database connected simply keeps no history.
 */
export function supabaseCallStore(tenantId: string, db: SupabaseClient | null): CallStore {
  return {
    async createCall() {
      if (!db) return null;
      try {
        return await createCallLog(db, tenantId, 'browser');
      } catch {
        console.error('[call-store] could not create the call log');
        return null;
      }
    },
    async updateCall(callId, fields) {
      if (!db || !callId) return;
      try {
        await updateAgentCallLog(db, tenantId, callId, fields);
      } catch {
        console.error('[call-store] could not update the call log');
      }
    },
    async recordAppointment(input) {
      if (!db) return false;
      try {
        await recordAppointment(db, {
          tenantId,
          bookingUid: input.bookingUid,
          status: input.status,
          start: input.startsAt,
          end: input.endsAt ?? undefined,
          type: input.appointmentType,
          name: input.attendeeName,
          email: input.attendeeEmail,
          callId: input.callId ?? undefined,
        });
        return true;
      } catch {
        console.error('[call-store] could not record the appointment');
        return false;
      }
    },
    async updateAppointment(bookingUid, status) {
      if (!db) return false;
      try {
        await updateAppointmentStatus(db, tenantId, bookingUid, status);
        return true;
      } catch {
        console.error('[call-store] could not update the appointment');
        return false;
      }
    },
    async recordReschedule(input) {
      if (!db) return false;
      try {
        await recordReschedule(db, tenantId, input.oldBookingUid, input.newBookingUid ?? undefined, input.startsAt, input.callId ?? undefined);
        return true;
      } catch {
        console.error('[call-store] could not record the reschedule');
        return false;
      }
    },
  };
}
