/**
 * Appointment Cancellation API
 *
 * Cancels one Cal.com booking by its uid. The UI only offers this once per
 * booking; Cal.com itself rejects cancelling a booking that's already cancelled.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cancelAppointment } from '@/lib/calendar';

const CancelRequestSchema = z.object({
	bookingId: z.string().min(1),
});

export async function POST(request: Request) {
	try {
		const { bookingId } = CancelRequestSchema.parse(await request.json());

		const result = await cancelAppointment(bookingId);

		if (!result.success) {
			return NextResponse.json(
				{ error: result.error || 'Failed to cancel appointment' },
				{ status: 500 },
			);
		}

		return NextResponse.json({
			success: true,
			message: 'Appointment cancelled',
			bookingId,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error('Cancel error:', error);
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
