import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { createReadTool } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createToolDefinitionFromAgentTool } from "../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createWriteTool } from "../../packages/coding-agent/src/core/tools/write.ts";
import type { Action, Scalar } from "../schema.ts";
import type { ProbeBudget } from "./budget.ts";

const parameters = Type.Object(
	{
		action: Type.String(),
		target: Type.String(),
		value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
	},
	{ additionalProperties: false },
);
/** An isolated capability world. It receives initial state, never goal/permitted/gold answers. */
export class ProbeWorld {
	readonly actions: Action[] = [];
	readonly trace: { tool: string; path?: string; action?: Action; status: "applied" | "denied"; error?: string }[] =
		[];
	private readonly files = new Map<string, string>();
	private readonly state: Record<string, Scalar>;
	readonly cwd: string;
	readonly budget: ProbeBudget;
	constructor(cwd: string, budget: ProbeBudget, initial: Record<string, Scalar>) {
		this.cwd = cwd;
		this.budget = budget;
		this.state = structuredClone(initial);
		this.files.set(resolve(cwd, "task.json"), JSON.stringify(this.state));
		this.files.set(resolve(cwd, "scratch.txt"), "");
	}
	private file(path: string): string {
		this.budget.assert();
		const key = resolve(path);
		if (!this.files.has(key)) {
			this.trace.push({ tool: "filesystem", path, status: "denied", error: "EVAL_TOOL_SCOPE" });
			throw new Error("EVAL_TOOL_SCOPE");
		}
		return key;
	}
	snapshot(): Record<string, Scalar> {
		return structuredClone(this.state);
	}
	execute(args: Static<typeof parameters>): void {
		try {
			this.budget.action();
			this.actions.push(structuredClone(args));
			// Semantic permissions are evaluated afterwards. Accept wrong in-world values without leaking the oracle.
			if (args.action === "set" && args.value !== undefined) this.state[args.target] = args.value;
			if (args.action === "scan") this.state[`scan:${args.target}`] = true;
			if (args.action.startsWith("approve-")) this.state[`${args.action}:${args.target}`] = args.value ?? true;
			this.files.set(resolve(this.cwd, "task.json"), JSON.stringify(this.state));
			this.trace.push({ tool: "task_action", action: structuredClone(args), status: "applied" });
		} catch (error) {
			this.trace.push({
				tool: "task_action",
				action: structuredClone(args),
				status: "denied",
				error: String(error),
			});
			throw error;
		}
	}
	tools(): ToolDefinition[] {
		const read = createReadTool(this.cwd, {
			operations: {
				access: async (path) => {
					this.file(path);
				},
				readFile: async (path) => {
					const key = this.file(path);
					this.trace.push({ tool: "read", path, status: "applied" });
					return Buffer.from(this.files.get(key)!);
				},
			},
		});
		const readWithinScope = read.execute;
		read.execute = (id, args, signal, onUpdate) => {
			// Reject before the ordinary tool's path-normalization metadata checks touch any outside path.
			this.file(resolve(this.cwd, args.path));
			return readWithinScope(id, args, signal, onUpdate);
		};
		const write = createWriteTool(this.cwd, {
			operations: {
				mkdir: async (path) => {
					this.budget.assert();
					if (resolve(path) !== resolve(this.cwd)) {
						this.trace.push({ tool: "write", path, status: "denied", error: "EVAL_TOOL_SCOPE" });
						throw new Error("EVAL_TOOL_SCOPE");
					}
				},
				writeFile: async (path, content) => {
					const key = this.file(path);
					if (key.endsWith("/task.json")) {
						this.trace.push({ tool: "write", path, status: "denied", error: "EVAL_USE_TASK_ACTION" });
						throw new Error("EVAL_USE_TASK_ACTION");
					}
					this.budget.action();
					this.files.set(key, content);
					this.actions.push({ action: "write", target: "scratch.txt", value: content });
					this.trace.push({ tool: "write", path, status: "applied" });
				},
			},
		});
		return [
			createToolDefinitionFromAgentTool(read),
			createToolDefinitionFromAgentTool(write),
			{
				name: "task_action",
				label: "Task action",
				description:
					"Act in the synthetic task world. Use set for a state key, scan for an inventory target, or the requested approve-* action for its scoped target (value is the phase). No external side effects.",
				parameters,
				execute: async (_id, args) => {
					this.execute(args as Static<typeof parameters>);
					return { content: [{ type: "text", text: "Action recorded." }], details: {} };
				},
			},
		];
	}
}
