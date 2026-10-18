import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function setStatusLine(ctx: ExtensionContext, state: number | "writing" | "paused" | undefined): void {
	try {
		if (!ctx.hasUI) return;
		const text =
			state === undefined
				? undefined
				: state === "writing"
					? "compaction: writing note"
					: state === "paused"
						? "compaction: paused, see /compaction-doctor"
						: state === 0
							? "compaction: on"
							: `compaction: ${state} checkpoint${state === 1 ? "" : "s"}`;
		ctx.ui.setStatus("context-memory", text);
	} catch {
		// Footer display is advisory; compaction and request guards remain authoritative.
	}
}
