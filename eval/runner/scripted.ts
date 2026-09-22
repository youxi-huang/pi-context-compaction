import type { AssistantMessage } from "@earendil-works/pi-ai";
import { note, reply } from "../pi/offline-host.ts";
import type { Transport } from "./types.ts";

/** Transparent metered script for offline mechanics. It intentionally abstains on task questions. */
export function scriptedReply(text: string): AssistantMessage {
	const message = reply(text);
	const output = Math.ceil(Buffer.byteLength(JSON.stringify(message.content), "utf8") / 3);
	return { ...message, usage: { ...message.usage, output, totalTokens: output } };
}
export function scriptedTransport(): Transport {
	return {
		mode: "scripted",
		async complete(request) {
			if (request.purpose === "writer") {
				const source = /f[123]-\d{5}/.exec(JSON.stringify(request.context))?.[0];
				return scriptedReply(
					source ? JSON.stringify(note(source)) : "Native scripted summary; consult the retained context.",
				);
			}
			return scriptedReply(JSON.stringify({ status: "abstain", claims: [] }));
		},
	};
}
