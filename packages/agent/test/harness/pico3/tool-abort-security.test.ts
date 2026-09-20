import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { tool } from "../../../src/harness/pico3/kinds/tool.ts";
import type { CoreTx } from "../../../src/harness/pico3/types.ts";

type Abort = NonNullable<typeof tool.abort>;

describe("persisted tool abort slot boundaries", () => {
	it.each(["__proto__", "constructor", "0", -1, 0.5, 4, 0])(
		"only updates a matching numeric slot: %s",
		async (index) => {
			const slot = { status: "running", waitingOn: "child" };
			const slots = [slot];
			const inherited = Object.create(Array.prototype);
			const constructorSlot = { status: "untouched" };
			Object.defineProperty(inherited, "constructor", { value: constructorSlot });
			Object.setPrototypeOf(slots, inherited);
			const before = Object.getOwnPropertyDescriptors(inherited);
			// Model a malformed persisted task, while keeping the test transaction in memory.
			const task = {
				id: "task",
				conversationId: "conversation",
				owns: [],
				input: { index, call: { id: "call", name: "read", arguments: {} } },
			} as unknown as Parameters<Abort>[0];
			const runtime = { now: () => 1 } as Parameters<Abort>[1];
			const finish = await tool.abort!(task, runtime, BACKGROUND_CONTEXT);
			const transaction = {
				appendEntry: () => "result",
				sticky: () => ({ turn: { tools: slots } }),
				emit: () => {},
			} as unknown as CoreTx;
			await finish(transaction, task, BACKGROUND_CONTEXT);
			expect(Object.getOwnPropertyDescriptors(inherited)).toEqual(before);
			expect(constructorSlot).toEqual({ status: "untouched" });
			expect(slot).toEqual(
				index === 0 ? { status: "aborted", entry: "result" } : { status: "running", waitingOn: "child" },
			);
		},
	);
});
