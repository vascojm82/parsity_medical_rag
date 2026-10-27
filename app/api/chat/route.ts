import { openai } from '@/lib/openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runSql } from '@/lib/agents/sql';
import { aggregate } from '@/lib/agents/aggregator';
import { findUpcomingBookings } from '@/lib/calendar';

const ChatRequestSchema = z.object({
	query: z.string().min(1),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.default([]),
});

const AppointmentInfoSchema = z.object({
	patientName: z
		.string()
		.min(1)
		.nullable()
		.describe('Patient name, or null if unknown.'),
	date: z.iso
		.date()
		.nullable()
		.describe('Appointment date as YYYY-MM-DD, or null if unresolved.'),
	time: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.describe(
			'Appointment time as HH:MM in 24-hour format, or null if unknown. No seconds.',
		),
	reason: z
		.string()
		.nullable()
		.describe('Appointment reason, or null if not provided.'),
	userMessage: z
		.string()
		.min(1)
		.describe(
			'Ask for missing details, or invite the user to confirm when complete.',
		),
});

const CancelInfoSchema = z.object({
	patientName: z
		.string()
		.min(1)
		.nullable()
		.describe('Name of the patient whose appointment to cancel, or null if unknown.'),
	date: z.iso
		.date()
		.nullable()
		.describe('Appointment date as YYYY-MM-DD, or null if not given.'),
	time: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.describe('Appointment time as HH:MM in 24-hour format, or null if not given.'),
	userMessage: z
		.string()
		.min(1)
		.describe('Ask for the patient name if it is missing.'),
});

// enable mutlippe actioms like sql && vector search
const selectorAgentSchema = z.object({
	actions: z
		.array(
			z.enum([
				'sql_search',
				'vector_search',
				'reject',
				'schedule_appointment',
				'cancel_appointment',
			]),
		)
		.describe(
			`The actions to take. Vector search is preferred, but if the query is too complex, reject it.
			Scheudle appointment possibly if the query is a scheduling request.
			Cancel appointment if the query asks to cancel an appointment, or answers a
			follow-up question (such as which time) about cancelling one in the previous messages.
			Only vector and sql search can be combined.
			`,
		),

	personalInfo: z
		.object({
			name: z.string().min(1).describe('The FULL name of the patient.'),
			dob: z
				.string()
				.min(1)
				.describe(
					'The date of birth of the patient. In this format: YYYY-MM-DD',
				),
		})
		.optional()
		.nullable(),
});

const fewShotExamples = [
	{
		query: 'What can you tell me about patient John Doe?',
		actions: ['vector_search'],
		reason: 'The query is a simple patient lookup, so we can use vector search.',
	},
	{
		query: 'What is the capital of Germany',
		actions: ['reject'],
		reason: 'Not a medical question.',
	},
	{
		query: 'Give me medical advice',
		actions: ['reject'],
		reason: 'We NEVER give medical advice.',
	},
	{
		query: 'Schedule an appointment for patient John Doe on October 25th, 2026 at 10:00 AM',
		actions: ['schedule_appointment'],
		reason: 'The query is a simple appointment scheduling request, so we can use the schedule_appointment action.',
	},
	{
		query: 'Cancel the appointment for Anastacia Keebler',
		actions: ['cancel_appointment'],
		reason: 'The query asks to cancel an appointment.',
	},
	{
		query: '10am on October 30th (after the assistant asked which appointment to cancel)',
		actions: ['cancel_appointment'],
		reason: 'Answers the follow-up question about which appointment to cancel.',
	},
	{
		query: 'How many patients have asthma?',
		actions: ['sql_search'],
		reason: 'The query asks for a specific number of patients with a condition, in this case asthma.',
	},
	{
		query: 'What can you tell me about smokers in this age group (40+) that are Hispanic?',
		actions: ['sql_search', 'vector_search'],
		reason: 'The query is a simple patient lookup, so we can use sql search and vector search.',
	},
];

/**
 * The chat pipeline — Week 3. This route IS the orchestrator:
 *
 * Week 3 · assignment: docs/CHALLENGE-TOOL-CALLING.md
 *
 *   1. accept the message + history   (done — parsed below)
 *   2. the selector decides which stores to hit      (lib/agents/selector.ts)
 *   3. call 0, 1, or 2 specialists, in parallel      (lib/agents/sql.ts, rag.ts)
 *   4. the aggregator streams the answer back        (lib/agents/aggregator.ts)
 *
 * Returns JSON: { message, schedulingAction? }. The optional action opens the calendar.
 */
export async function POST(request: Request) {
	try {
		const { query, messages } = ChatRequestSchema.parse(
			await request.json(),
		);
		// selector
		// sql searh vector search OR reject
		const response = await openai.responses.parse({
			model: 'gpt-6-luna',
			input: [
				{
					role: 'system',
					content: `We are a medical facility. We need help looking up patient info. the query path to take
						Generally use sql AND vector search together.`,
				},
				{
					role: 'user',
					content: `
					query: ${query}
					previous messages: ${JSON.stringify(messages.slice(-5))}
					Example responses: ${JSON.stringify(fewShotExamples)}
					`, // more context
				},
			],
			text: {
				format: zodTextFormat(selectorAgentSchema, 'selector_agent'),
			},
		});

		// if rejected then retrn the rejection reason
		if (response.output_parsed?.actions.includes('reject')) {
			return NextResponse.json({
				message: "I'm sorry, I can't help with that.",
			});
		}

		if (response.output_parsed?.actions.includes('cancel_appointment')) {
			// extract who + when, then match against the patient's real Cal.com bookings
			const extraction = await openai.responses.parse({
				model: 'gpt-6-luna',
				input: [
					{
						role: 'system',
						content: `
							Extract the patient name, date, and time of the appointment the user wants to cancel.
							Today is ${new Date().toISOString().split('T')[0]}. Resolve relative dates such as Monday or tomorrow using today and the conversation.
							Use the previous messages to fill in the patient name or date when the user answers a follow-up question.
							Dates must be YYYY-MM-DD and times HH:MM (24-hour, no seconds).
							Use null for missing fields. DO NOT MAKE UP INFORMATION. ONLY USE THE INFORMATION PROVIDED.
							`,
					},
					{
						role: 'user',
						content: `
						Query: ${query}
						Previous messages: ${JSON.stringify(messages.slice(-5))}
						`,
					},
				],
				text: {
					format: zodTextFormat(CancelInfoSchema, 'cancel_info'),
				},
			});

			const { patientName, date, time, userMessage } = CancelInfoSchema.parse(
				extraction.output_parsed,
			);

			if (!patientName) {
				return NextResponse.json({ message: userMessage });
			}

			const bookings = await findUpcomingBookings(patientName);

			if (bookings.length === 0) {
				return NextResponse.json({
					message: `I couldn't find any upcoming appointments for **${patientName}**.`,
				});
			}

			const list = (items: typeof bookings) =>
				items.map((b) => `- ${b.date} at ${b.time}`).join('\n');

			// the time identifies the appointment; only ask for it when there's more than one
			if (!time && bookings.length > 1) {
				return NextResponse.json({
					message: `What time is the appointment for **${patientName}** you want to cancel? Their upcoming appointments are:\n\n${list(bookings)}`,
				});
			}

			const matches = time
				? bookings.filter(
						(b) => b.time === time && (!date || b.date === date),
					)
				: bookings;

			if (matches.length !== 1) {
				return NextResponse.json({
					message:
						matches.length === 0
							? `I couldn't find an appointment for **${patientName}**${date ? ` on ${date}` : ''} at ${time}. Their upcoming appointments are:\n\n${list(bookings)}`
							: `**${patientName}** has more than one appointment at ${time}. Which date?\n\n${list(matches)}`,
				});
			}

			const [match] = matches;

			return NextResponse.json({
				message: `Are you sure you want to cancel the appointment for **${patientName}** on ${match.date} at ${match.time}?`,
				cancellationAction: {
					bookingId: match.uid,
					patientName,
					date: match.date,
					time: match.time,
				},
			});
		}

		if (response.output_parsed?.actions.includes('schedule_appointment')) {
			console.log("SCHEDULE APPT!");
			// extract the patient name and date from the query OR ask them for the information

			const response = await openai.responses.parse({
				model: 'gpt-6-luna',
				input: [
					{
						role: 'system',
						content: `
							Extract the patient name, date, time, and reason to schedule an appointment.
							Today is ${new Date().toISOString().split('T')[0]}. Resolve relative dates such as Monday or tomorrow using today and the conversation.
							Dates must be YYYY-MM-DD and times HH:MM (24-hour, no seconds).
							Use null for missing or ambiguous fields, never placeholders such as "Not provided".
							Ask for missing patient name, date, or time in userMessage. Reason is optional.
							DO NOT MAKE UP INFORMATION. ONLY USE THE INFORMATION PROVIDED.
							`,
					},
					{
						role: 'user',
						content: `
						Query: ${query}
						Previous messages: ${JSON.stringify(messages.slice(-5))}
						`,
					},
				],
				text: {
					format: zodTextFormat(
						AppointmentInfoSchema,
						'appointment_info',
					),
				},
			});

			const { patientName, date, time, reason, userMessage } =
				AppointmentInfoSchema.parse(response.output_parsed);

			return NextResponse.json({
				message: userMessage,
				schedulingAction:
					patientName && date && time
						? { patientName, date, time, reason }
						: null,
			});
		}

		// do we have both actions?
		if (
			response.output_parsed?.actions.includes('sql_search') &&
			response.output_parsed?.actions.includes('vector_search')
		) {
			const [sqlSummary, vectorSummary] = await Promise.all([
				runSql(query, messages),
				searchClinicalNotes(query),
			]);

			console.log('sqlSummary', sqlSummary);
			console.log('vectorSummary', vectorSummary);

			const summary = await aggregate(
				// you summarize the results
				query,
				messages,
				`
				SQL Summary: ${sqlSummary}\n\n
				Vector Summary: ${vectorSummary}
				`,
			);

			return NextResponse.json({
				message: summary,
			});
		}
		// if vector search then run the vector search
		if (response.output_parsed?.actions.includes('vector_search')) {
			const summary = await aggregate(
				query,
				messages,
				`
				Vector Summary: ${await searchClinicalNotes(query)}
				`,
			);
			return NextResponse.json({ message: summary });
		}

		if (response.output_parsed?.actions.includes('sql_search')) {
			const summary = await aggregate(
				query,
				messages,
				`
				SQL Summary: ${await runSql(query, messages)}
				`,
			);
			return NextResponse.json({ message: summary });
		}
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error('Chat error:', error);
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
