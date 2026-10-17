import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type MemoryNote, noteSections, sourceRole, sourceText } from "../notes.ts";

/**
 * Why a quotation failed: its exact text sits in another entry; it matches only after spacing and punctuation are
 * normalized; or no readable entry contains it.
 */
export type QuoteFailureKind = "elsewhere" | "format" | "absent";

export interface QuoteLocation {
	entryId: string;
	role: string;
}

export interface QuoteFailure {
	section: (typeof noteSections)[number];
	index: number;
	quote: string;
	cited: readonly string[];
	kind: QuoteFailureKind;
	/** Readable entries that contain the quotation, exactly for `elsewhere` and after normalization for `format`. */
	foundIn: QuoteLocation[];
}

export interface QuoteDiagnosis {
	failures: QuoteFailure[];
	/** A `sources` or `supersedes` ID is unreadable: the note fails on scope, not only on quotations. */
	unreadable: boolean;
}

/** Content-free counts, safe for status output and error messages. */
export interface QuoteCounts {
	failed: number;
	elsewhere: number;
	format: number;
	absent: number;
}

const MAX_LOCATIONS = 5;

/** Spacing, compatibility forms and typographic punctuation; used only to classify, never to accept. */
export function normalizeQuote(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B\u2032]/gu, "'")
		.replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
		.replace(/[\u2010-\u2015\u2212]/gu, "-")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Every failing quotation of a schema-valid note, where the validator stops at the first. It decides eligibility
 * for a quotation repair and builds its request and messages; acceptance stays with `validateNote`.
 */
export function diagnoseQuotes(note: MemoryNote, branch: readonly SessionEntry[]): QuoteDiagnosis {
	// Later duplicates win, as in `validateNoteContent`.
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const text = (id: string): string | undefined => {
		const entry = byId.get(id);
		return entry ? sourceText(entry) || undefined : undefined;
	};
	const readable = [...byId.values()].flatMap((entry) => {
		const value = sourceText(entry);
		return value ? [{ entry, text: value }] : [];
	});
	let normalized: { entry: SessionEntry; text: string }[] | undefined;
	const failures: QuoteFailure[] = [];
	let unreadable = false;
	for (const section of noteSections) {
		note[section].forEach((item, index) => {
			if (item.sources.some((id) => !text(id)) || item.supersedes?.some((id) => !text(id))) unreadable = true;
			const quote = item.quote;
			if (!quote || item.sources.some((id) => text(id)?.includes(quote))) return;
			const exact = readable.filter((source) => source.text.includes(quote));
			let kind: QuoteFailureKind = "elsewhere";
			let found = exact;
			if (!exact.length) {
				normalized ??= readable.map((source) => ({ entry: source.entry, text: normalizeQuote(source.text) }));
				const target = normalizeQuote(quote);
				found = target ? normalized.filter((source) => source.text.includes(target)) : [];
				kind = found.length ? "format" : "absent";
			}
			failures.push({
				section,
				index,
				quote,
				cited: [...item.sources],
				kind,
				foundIn: found
					.slice(0, MAX_LOCATIONS)
					.map((source) => ({ entryId: source.entry.id, role: sourceRole(source.entry) })),
			});
		});
	}
	return { failures, unreadable };
}

export function quoteCounts(failures: readonly QuoteFailure[]): QuoteCounts {
	const counts: QuoteCounts = { failed: failures.length, elsewhere: 0, format: 0, absent: 0 };
	for (const failure of failures) counts[failure.kind]++;
	return counts;
}

/** The validator's code with counts per class; never the quotation text. */
export function quoteFailureMessage(counts: QuoteCounts, repaired = false): string {
	const parts = [
		counts.elsewhere ? `${counts.elsewhere} found verbatim in other entries` : "",
		counts.format ? `${counts.format} matching only after spacing or punctuation changes` : "",
		counts.absent ? `${counts.absent} found in no entry` : "",
	].filter(Boolean);
	return `CONTEXT_NOTE_QUOTE: ${counts.failed} quotation${counts.failed === 1 ? " does" : "s do"} not match the entries cited${parts.length ? ` (${parts.join(", ")})` : ""}${repaired ? " after one quotation repair" : ""}. No checkpoint committed; original history retained.`;
}

/** One line per failing field for a tool error: where the text actually is, so the model can cite it. */
export function quoteFeedback(failures: readonly QuoteFailure[]): string {
	return failures
		.map((failure) => {
			const where = failure.foundIn.map((location) => `${location.entryId} (${location.role})`).join(", ");
			const field = `${failure.section}[${failure.index}].quote`;
			if (failure.kind === "elsewhere")
				return `${field} is not in ${failure.cited.join(", ")}; the exact text is in ${where}. Cite that entry, or drop the quote. Text from an assistant or tool entry is not a user ruling.`;
			if (failure.kind === "format")
				return `${field} differs from ${where} in spacing or punctuation; copy the text exactly or drop the quote.`;
			return `${field} is in no readable entry; quote exact text from a cited entry or drop the quote.`;
		})
		.join("\n");
}
