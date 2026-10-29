/**
 * Cal.com Integration
 *
 * Week 3 · YOUR TASK. Prove a booking works with STATIC test data before you
 * wire the agent to it — cohort 3 lost an hour to a v1-vs-v2 API mismatch that
 * had nothing to do with the LLM.
 *
 * Provides appointment scheduling via Cal.com API.
 * This is the "action" part of the human-in-the-loop pattern.
 *
 * Setup:
 * 1. Create account at https://cal.com
 * 2. Create an event type (e.g., "Patient Appointment")
 * 3. Get API key from Settings -> Developer -> API Keys
 * 4. Get event type ID from the URL when editing the event type
 * 5. Add to .env: CAL_API_KEY and CAL_EVENT_TYPE_ID
 */

const CAL_API_BASE = 'https://api.cal.com/v1';

// The clinic's (and Cal.com profile's) timezone. Times from the UI are wall-clock here.
const TIME_ZONE = 'America/New_York';

/**
 * '2026-10-30T15:00:00' (wall-clock in timeZone) -> '2026-10-30T19:00:00.000Z'.
 * Strings that already carry a timezone (Z or ±HH:MM) are passed through as UTC.
 * Without this, Cal.com reads a timezone-less time as UTC and books 4–5 hours early.
 */
function toUtcIso(local: string, timeZone: string): string {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(local)) return new Date(local).toISOString();

  const asUtc = new Date(`${local}Z`);
  const inZone = new Date(asUtc.toLocaleString('en-US', { timeZone }));
  const inUtc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(asUtc.getTime() + (inUtc.getTime() - inZone.getTime())).toISOString();
}

export interface ScheduleRequest {
  patientName: string;
  dateTime: string; // ISO 8601 format
  patientEmail?: string;
  notes?: string | null;
}

export interface ScheduleResult {
  success: boolean;
  bookingId?: string;
  bookingUrl?: string;
  error?: string;
}

/**
 * Check if Cal.com is configured
 */
export function isCalConfigured(): boolean {
  return Boolean(process.env.CAL_API_KEY && process.env.CAL_EVENT_TYPE_ID);
}

/**
 * Schedule an appointment via Cal.com API
 *
 * TODO: Implement this function
 * 1. Check if Cal.com is configured
 * 2. Make POST request to Cal.com bookings API
 *    - Endpoint: ${CAL_API_BASE}/bookings?apiKey=${apiKey}
 *    - Body: { eventTypeId, start, responses: { name, email }, metadata }
 * 3. Handle response and errors appropriately
 * 4. Return ScheduleResult with booking details
 *
 * Cal.com API docs: https://cal.com/docs/api-reference/v1/bookings
 */
export async function scheduleAppointment(
  request: ScheduleRequest
): Promise<ScheduleResult> {
  // TODO: Implement Cal.com booking API call

  if (!isCalConfigured()) {
    return {
      success: false,
      error: 'Cal.com is not configured. Set CAL_API_KEY and CAL_EVENT_TYPE_ID.',
    };
  }

  // TODO: Make the API call to Cal.com
  const apiKey = process.env.CAL_API_KEY;
  const eventTypeId = parseInt(process.env.CAL_EVENT_TYPE_ID || '0', 10);

  const res = await fetch("https://api.cal.com/v2/bookings",
  {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': '2024-08-13',
        'Content-Type': 'application/json',
      },
      method: "POST",
      body: JSON.stringify({
        "eventTypeId": eventTypeId,
        "start": toUtcIso(request.dateTime, TIME_ZONE),
        "attendee": {
          "name": request.patientName,
          "email": request.patientEmail ?? 'miguel_vasconce@hotmail.com',
          "timeZone": TIME_ZONE,
          "language": "en"
        },
        "location": {
          "type": "phone"
        },
        "metadata": {
        }
      })
  });

  const response = await res.json();

  console.log('response: ', response);

  if (!res.ok) {
    return {
      success: false,
      error: response.error.message || `Cal.com returned ${res.status}`,
    };
  }

  return {
    success: true,
    bookingId: response.data.uid,
  };
}

export type UpcomingBooking = {
  uid: string;
  start: string; // ISO from Cal.com (UTC)
  date: string; // YYYY-MM-DD in TIME_ZONE
  time: string; // HH:MM (24h) in TIME_ZONE
};

// Cal.com returns UTC; the chat and the user speak New York wall-clock time.
function toLocalDateTime(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Upcoming (not cancelled) bookings whose attendee name contains patientName.
 * Cal.com is the source of truth, so a cancelled booking never shows up here.
 */
export async function findUpcomingBookings(patientName: string): Promise<UpcomingBooking[]> {
  if (!isCalConfigured()) {
    throw new Error('Cal.com is not configured. Set CAL_API_KEY and CAL_EVENT_TYPE_ID.');
  }

  const res = await fetch('https://api.cal.com/v2/bookings?status=upcoming', {
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': '2024-08-13',
    },
  });

  const response = await res.json();

  if (!res.ok || response.status !== 'success') {
    throw new Error(response.error?.message || `Cal.com returned ${res.status}`);
  }

  const name = patientName.toLowerCase();

  return (response.data as { uid: string; start: string; attendees?: { name: string }[] }[])
    .filter((b) => b.attendees?.some((a) => a.name.toLowerCase().includes(name)))
    .map((b) => ({ uid: b.uid, start: b.start, ...toLocalDateTime(b.start) }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Cancel an appointment
 *
 * TODO (Extension): Implement appointment cancellation
 */
export async function cancelAppointment(bookingId: string): Promise<ScheduleResult> {
  if (!isCalConfigured()) {
    return {
      success: false,
      error: 'Cal.com is not configured. Set CAL_API_KEY and CAL_EVENT_TYPE_ID.',
    };
  }

  // v2 cancels by the booking's uid; a host cancellation requires a reason
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(bookingId)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': '2024-08-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cancellationReason: 'Cancelled by clinic staff',
    }),
  });

  const response = await res.json();

  if (!res.ok || response.status !== 'success') {
    return {
      success: false,
      error: response.error?.message || `Cal.com returned ${res.status}`,
    };
  }

  return {
    success: true,
    bookingId,
  };
}

/**
 * Reschedule an appointment
 *
 * v2 moves the booking to a new start time. Cal.com creates a NEW booking (new uid)
 * and marks the old one as rescheduled, so the returned bookingId is the new uid.
 */
export async function rescheduleAppointment(
  bookingId: string,
  newDateTime: string
): Promise<ScheduleResult> {
  if (!isCalConfigured()) {
    return {
      success: false,
      error: 'Cal.com is not configured. Set CAL_API_KEY and CAL_EVENT_TYPE_ID.',
    };
  }

  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'cal-api-version': '2024-08-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // same wall-clock -> UTC conversion as booking, or the new slot lands 4–5 hours early
      start: toUtcIso(newDateTime, TIME_ZONE),
      reschedulingReason: 'Rescheduled by clinic staff',
    }),
  });

  const response = await res.json();

  if (!res.ok || response.status !== 'success') {
    return {
      success: false,
      error: response.error?.message || `Cal.com returned ${res.status}`,
    };
  }

  return {
    success: true,
    bookingId: response.data.uid,
  };
}
