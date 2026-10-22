// Lifted unchanged from the preview into the host-neutral core (v0.7.0 WP2 step 2); only the
// identity and notes imports moved to the core's copies.
import { isRecord } from "./identity.ts";
import { noteSchema } from "./notes.ts";

/** The seven note sections, in schema order. */
export const NOTE_SECTIONS: readonly string[] = Object.freeze(Object.keys(noteSchema.properties));

/**
 * The schema envelope a writer answer arrived in: `type`, a string `type` beside the seven sections; `schema`,
 * the sections under `properties` beside `type` and `required`.
 */
export type NoteEnvelope = "type" | "schema";

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const present = Object.keys(value);
	return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Asked for a note matching its JSON Schema, GPT-6 Luna sometimes answered with the schema's keywords around a
 * note. Only those two shapes are removed, one level deep, and only when the seven sections are exactly the keys
 * left; every other answer is returned as it came. What is returned still passes every check a note does before
 * it can commit, so no unchecked text reaches a checkpoint.
 */
export function removeNoteEnvelope(value: unknown): { value: unknown; envelope?: NoteEnvelope } {
	if (!isRecord(value)) return { value };
	if (typeof value.type === "string" && hasExactly(value, [...NOTE_SECTIONS, "type"]))
		return { value: Object.fromEntries(Object.entries(value).filter(([key]) => key !== "type")), envelope: "type" };
	if (
		hasExactly(value, ["type", "properties", "required"]) &&
		isRecord(value.properties) &&
		hasExactly(value.properties, NOTE_SECTIONS)
	)
		return { value: value.properties, envelope: "schema" };
	return { value };
}
