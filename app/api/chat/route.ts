import { openai, openaiProvider } from '@/lib/openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { toPineconeFilter, searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';

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

const selectorAgentSchema = z.object({
	action: z
		.enum(['sql_search', 'vector_search', 'reject'])
		.describe(
			'The action to take. Vector search is preferred, but if the query is too complex, reject it.',
		),
	reason: z.string().min(5).describe('The reason you chose this action.'),
	rejectionReason: z
		.string()
		.min(1)
		.describe('The reason you rejected the query.')
		.nullable(),
	personalInfo: z
		.object({
			name: z.string().min(1).describe('The FULL name of the patient.'),
			dob: z
				.string()
				.min(1)
				.describe(
					'The date of birth of the patient. In this format: YYYY-MM-DD',
				)
				.nullable(),
		})
		.optional()
		.nullable(),
	filters: z
		.object({
			gender: z.enum(['male', 'female']).nullable()
			.describe('Only if the user restricts by gender'),
			minAge: z.number().int().nullable()
			.describe('Lower age bound, e.g. "over 65" -> 66, "65 and older" -> 65'),
			maxAge: z.number().int().nullable()
			.describe('Upper age bound'),
			isAlive: z.boolean().nullable()
			.describe('true for living patients, false for deceased; null if not mentioned'),
			race: z.string().nullable(),
			ethnicity: z.string().nullable(),
		})
		.describe('Metadata filters stated in the query. Use null for anything not mentioned.'),
});

const fewShotExamples = [
	{
		query: 'What can you tell me about patient John Doe?',
		action: 'vector_search',
		reason: 'The query is a simple patient lookup, so we can use vector search.',
	},
	{
		query: 'What is the capital of Germany',
		action: 'reject',
		reason: 'Not a medical question.',
	},
	{
		query: 'Give me medical advice',
		action: 'reject',
		reason: 'We NEVER give medical advice.',
	},
	{
		query: 'Patients with Hispanic ethnicity',
		action: 'vector_search',
		reason: 'Demographic filter on clinical notes.',
		filters: { gender: null, minAge: null, maxAge: null, isAlive: null, race: null, ethnicity: 'Hispanic or Latino' },
	},
	{
		query: 'Non Hispanic patients',
		action: 'vector_search',
		reason: 'Demographic filter on clinical notes.',
		filters: { gender: null, minAge: null, maxAge: null, isAlive: null, race: null, ethnicity: 'Non Hispanic or Latino' },
	},
	{
		query: 'Patients of the black race',
		action: 'vector_search',
		reason: 'Demographic filter on clinical notes.',
		filters: { gender: null, minAge: null, maxAge: null, isAlive: null, race: 'Black or African American', ethnicity: null },
	},
	{
		query: 'Patients of asian race',
		action: 'vector_search',
		reason: 'Demographic filter on clinical notes.',
		filters: { gender: null, minAge: null, maxAge: null, isAlive: null, race: 'Asian', ethnicity: null },
	},
	{
		query: 'Women over 65 with chest pain',
		action: 'vector_search',
		reason: 'Symptom search narrowed by gender and age.',
		filters: { gender: 'female', minAge: 66, maxAge: null, isAlive: null, race: null, ethnicity: null },
	},
	{
		query: 'Men under 40 with high blood pressure',
		action: 'vector_search',
		reason: 'Symptom search narrowed by gender and age.',
		filters: { gender: 'male', minAge: null, maxAge: 39, isAlive: null, race: null, ethnicity: null },
	},
	{
		query: 'Patients that passed away',
		action: 'vector_search',
		reason: 'Note search narrowed to deceased patients.',
		filters: { gender: null, minAge: null, maxAge: null, isAlive: false, race: null, ethnicity: null },
	},
	{
		query: 'Female patients with asthma',
		action: 'vector_search',
		reason: 'Condition search narrowed by gender.',
		filters: { gender: 'female', minAge: null, maxAge: null, isAlive: null, race: null, ethnicity: null },
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
 * Scheduling actions ride back to the UI in the X-Scheduling-Action header.
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
					content:   `You route questions for a medical facility's patient-notes assistant.

								Actions:
								- vector_search: search clinical notes by meaning. Supports filtering on
								gender, age range, alive/deceased, race, and ethnicity. Use this for
								questions about patients' symptoms, history, or notes, including when the
								question narrows by demographics (e.g. "Hispanic patients with diabetes").
								- sql_search: exact counts and aggregates over structured records
								(e.g. "how many patients...", "average age of..."). Not implemented yet.
								- reject: not a medical question, or a request for medical advice.

								Fill "filters" only with constraints the user explicitly states.`,

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
		if (response.output_parsed?.action === 'reject') {
			return NextResponse.json({
				message: response.output_parsed.rejectionReason,
			});
		}

		if (response.output_parsed?.action === 'vector_search') {
			const filter = toPineconeFilter({...response.output_parsed.filters, dob: response.output_parsed.personalInfo?.dob});
			const searchResults = await searchClinicalNotes(query, filter);

			if(searchResults === '-1') {
				return NextResponse.json({message: "No matching clinical notes were found."});
			}

			const summary = await openai.responses.create({
				model: 'gpt-6-sol',
				input: [
					{
						role: 'system',
						content:
							'Summarize the following notes. Format names to not have the numbers and make it concise and readable to a non-medical person.',
					},
					{ role: 'user', content: searchResults },
				],
			});

			return NextResponse.json(summary.output_text);
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
