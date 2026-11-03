import {
  createCallLog,
  recordAppointment,
  recordReschedule,
  updateAgentCallLog,
  updateAppointmentStatus,
} from '../../server/integrations/supabase.js';
import type { CallStore } from './receptionist.js';

/**
 * Call and appointment persistence for one clinic, backed by the central Supabase project.
 * Everything is best effort: a database problem must never drop a live call, so failures are
 * logged by class only (never with provider messages) and reported to the caller as `false`/`null`.
 */
export function supabaseCallStore(tenantId: string): CallStore {
  return {
    async createCall() {
      try {
        return await createCallLog(tenantId, null, 'browser');
      } catch {
        console.error('[call-store] could not create the call log');
        return null;
      }
    },
    async updateCall(callId, fields) {
      if (!callId) return;
      try {
        await updateAgentCallLog(tenantId, callId, fields);
      } catch {
        console.error('[call-store] could not update the call log');
      }
    },
    async recordAppointment(input) {
      try {
        await recordAppointment({
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
      try {
        await updateAppointmentStatus(tenantId, bookingUid, status);
        return true;
      } catch {
        console.error('[call-store] could not update the appointment');
        return false;
      }
    },
    async recordReschedule(input) {
      try {
        await recordReschedule(tenantId, input.oldBookingUid, input.newBookingUid ?? undefined, input.startsAt, input.callId ?? undefined);
        return true;
      } catch {
        console.error('[call-store] could not record the reschedule');
        return false;
      }
    },
  };
}
