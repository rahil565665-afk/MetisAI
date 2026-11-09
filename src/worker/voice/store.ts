import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DatabaseAdviceError,
  createCallLog,
  recordAppointment,
  recordReschedule,
  updateAgentCallLog,
  updateAppointmentStatus,
} from '../../server/integrations/clinicDatabase.js';
import type { CallStore } from './receptionist.js';

export const NO_DATABASE_PROBLEM = 'No Supabase database is connected to this clinic, so this call is not saved to the history. Add one under Integrations → Clinic Supabase database.';
const UNSAVED_PROBLEM = 'The call history could not be saved. Check the clinic’s Supabase connection under Integrations.';

/** Advice that is safe to show as it is, or a general line when the failure was not one we recognise. */
function problemText(error: unknown): string {
  return error instanceof DatabaseAdviceError ? error.message : UNSAVED_PROBLEM;
}

/**
 * Call and appointment persistence for one clinic, written to that clinic's own Supabase project.
 * Nothing here ever throws, because a database problem must never drop a live call. Failures are
 * logged by class only (never with provider messages) and returned as `false`/`problem`, so the
 * dashboard can say why a call was not saved instead of silently showing nothing.
 */
export function supabaseCallStore(tenantId: string, db: SupabaseClient | null): CallStore {
  return {
    async createCall(initial) {
      if (!db) return { id: null, problem: NO_DATABASE_PROBLEM };
      try {
        return { id: await createCallLog(db, tenantId, 'browser', { ...initial }), problem: null };
      } catch (error) {
        console.error('[call-store] could not create the call log');
        return { id: null, problem: problemText(error) };
      }
    },
    async updateCall(callId, fields) {
      if (!db || !callId) return false;
      try {
        await updateAgentCallLog(db, tenantId, callId, { ...fields });
        return true;
      } catch {
        console.error('[call-store] could not update the call log');
        return false;
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
          phone: input.attendeePhone ?? undefined,
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
