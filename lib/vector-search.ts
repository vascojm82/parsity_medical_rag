/**
 * Vector search over the clinical notes — Week 2, built together in class.
 *
 * The shape we're building, two-stage retrieval in one call:
 *   1. embed the query, ask Pinecone for the nearest topK notes (wide, cheap)
 *   2. rerank those candidates against the query, keep topN (narrow, careful)
 *
 * Returns both lists so you can log them side by side and SEE what reranking
 * changed on a given query.
 */

import type { SearchResult } from './pinecone';
import { createEmbedding } from './openai';
import { pinecone } from './pinecone';

export type VectorSearchOptions = {
	topK?: number; // candidates the cosine search fetches
	topN?: number; // candidates kept after reranking
};

export type PineconeFilter = Record<string, Record<string, unknown>>;

// Converts selector filter output to something Pinecone will accept
export function toPineconeFilter(f: any): PineconeFilter | undefined  {
  const clauses = [];
  if (f.dob) 			  clauses.push({ dob: { $eq: f.dob } });
  if (f.gender)           clauses.push({ gender: { $eq: f.gender } });
  if (f.minAge !== null)  clauses.push({ age: { $gte: f.minAge } });
  if (f.maxAge !== null)  clauses.push({ age: { $lte: f.maxAge } });
  if (f.isAlive !== null) clauses.push({ isAlive: { $eq: f.isAlive } });
  if (f.race)             clauses.push({ race: { $eq: f.race } });
  if (f.ethnicity)        clauses.push({ ethnicity: { $eq: f.ethnicity } });

  // merge clauses into one flat object; same-field ops combine, e.g. age: { $gte: 50, $lte: 60 }
  const filter = clauses.reduce<Record<string, Record<string, unknown>>>((acc, clause) => {
    for (const [field, ops] of Object.entries(clause)) acc[field] = { ...acc[field], ...ops };
    return acc;
  }, {});

  return clauses.length ? filter : undefined;
}

export async function searchClinicalNotes(
	query: string,
	filter?: PineconeFilter,
	options: VectorSearchOptions = {},
): Promise<string> {
	// query -> string[]
	const embedding = await createEmbedding(query);
	// search pinecone
	const results = await pinecone.index(process.env.PINECONE_INDEX!).query({
		vector: embedding, //query represented as 1536 vector
		topK: 10,
		includeMetadata: true, // contnet we got race / gender / age / etc.
		filter: filter
	});

	const matchesWithScores = results.matches.map((match) => ({
		id: match.id,
		score: match.score,
		content: match.metadata?.content as string,
		metadata: match.metadata,
	}));

	// filter -> terrible matches

	// cosine similarity agains the query and the doc

	console.log(JSON.stringify(matchesWithScores, null, 2));

	// filter out scores below 0.3
	const filteredMatches = matchesWithScores.filter(
		(match) => match?.score && match.score > 0.3,
	);

	// Removed second copy of content inside metadata as it was making the
	// query+document pair supported by pinecone rerank past its 1024 tokens limit.
	const docs: string[] = filteredMatches.map((match) => {
		const { content, ...meta } = match.metadata ?? {};

		return `note: ${content}\n\nmetadata: ${JSON.stringify(meta)}`;
	});

	if (docs.length === 0) {
		console.log(
			results.matches.length === 0
				? `No notes matched filter: ${JSON.stringify(filter)}`
				: `All ${results.matches.length} matches scored below 0.3`,
		);
		
		// No matching clinical notes were found.
		return '-1';
	}

	const reranked = await pinecone.inference.rerank({
		model: 'bge-reranker-v2-m3',
		query: query, //text
		documents: docs, //text,  array of strings
		topN: 5,
	});

	// scores against the query and the doc

	console.log(JSON.stringify(reranked.data, null, 2));

	return reranked.data.map((result) => result.document?.text).join('\n');
}
