/**
 * Appointment Rescheduling API
 *
 * Moves one Cal.com booking (by uid) to a new wall-clock date/time in the
 * clinic's timezone. Cal.com issues a new uid for the moved booking.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rescheduleAppointment } from '@/lib/calendar';

const RescheduleRequestSchema = z.object({
	bookingId: z.string().min(1),
	dateTime: z.iso.datetime({ local: true }), // '2026-11-05T14:00:00', no timezone
});

export async function POST(request: Request) {
	try {
		const { bookingId, dateTime } = RescheduleRequestSchema.parse(
			await request.json(),
		);

		const result = await rescheduleAppointment(bookingId, dateTime);

		if (!result.success) {
			return NextResponse.json(
				{ error: result.error || 'Failed to reschedule appointment' },
				{ status: 500 },
			);
		}

		return NextResponse.json({
			success: true,
			message: 'Appointment rescheduled',
			bookingId: result.bookingId,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error('Reschedule error:', error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: 'Internal server error',
			},
			{ status: 500 },
		);
	}
}
