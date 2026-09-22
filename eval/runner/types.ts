import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { MemoryNote } from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import type { StructuralFinding } from "../pi/structural.ts";
import type { Fixture, Probe } from "../schema.ts";
import type { Observation, Score } from "../scorer.ts";

export type Arm = "project" | "native";
/** The transport sees only the actual request, not fixture/gold/another arm or evaluator callbacks. */
export interface TransportRequest {
	purpose: "writer" | "task";
	context: Context;
	model: Model<Api>;
	maxTokens: number;
	reasoning?: SimpleStreamOptions["reasoning"];
	signal: AbortSignal;
}
export interface Transport {
	mode: "scripted";
	complete(request: TransportRequest): Promise<AssistantMessage>;
}
export interface ProbeLimits {
	actions: number;
	toolRounds: number;
	outputTokens: number;
	calls: number;
	timeoutMs: number;
}
export interface CallRecord {
	purpose: "writer" | "task";
	at: number;
	maxTokens: number;
	reasoning?: SimpleStreamOptions["reasoning"];
	context: Context;
	usage: Usage | null;
	outputTokens: number | null;
	result?: AssistantMessage;
	error?: string;
	ms?: number;
}
export interface ProbeResult {
	id: string;
	target: Probe["target"];
	checkpoint: string;
	copyFile?: string;
	status: "completed" | "blocked";
	error?: string;
	rawAnswer?: string;
	score: Score;
	observation?: Observation;
	limits?: ProbeLimits;
	requests: CallRecord[];
	toolTrace: unknown[];
	firstTool?: string;
	firstTaskAction?: Observation["actions"][number] | null;
	worldTrace?: unknown[];
	finalState?: Record<string, unknown>;
	injection: boolean;
}
export interface CheckpointResult {
	id: string;
	status: "committed" | "failed" | "blocked";
	error?: string;
	file?: string;
	sourceHash?: string;
	firstKeptEntryId?: string;
	preparedReleaseTokens?: number;
	releasedTokens: number;
	keptTokens?: number;
	repairUsed?: boolean | null;
	previousNoteFloorEffective?: boolean;
	capacityTruncationReason?: string | null;
	effectiveThinkingLevel?: string;
	cumulativeSourceTokens: number;
	budget?: unknown;
	noteJsonTokens?: number;
	renderedNoteTokens?: number;
	lineageTokens?: number;
	continuationTokens?: number;
	triggerAt?: number;
	committedAt?: number;
	dispatchAt?: number;
	nextTaskRequestAt?: number;
	compactionMs?: number;
	orchestrationMs?: number;
	resumeRequestDelayMs?: number;
	pauseMs?: number;
	requests: CallRecord[];
	structural?: StructuralFinding;
}
export interface WriterReview {
	response: unknown;
	promoted: boolean;
	method: "scripted" | "manual-semantic";
}
/** Evaluator-only semantic inspection. This function and its inputs never cross into TransportRequest. */
export type WriterReviewer = (input: {
	fixture: Fixture;
	probe: Probe;
	note: MemoryNote | null;
	summary: string;
	injection: boolean;
}) => Promise<WriterReview>;
export interface RunResult {
	id: string;
	fixture: string;
	arm: Arm;
	replicate: number;
	status: "completed" | "failed";
	directory: string;
	metadata: Record<string, unknown>;
	checkpoints: CheckpointResult[];
	probes: ProbeResult[];
	counts: Record<string, number>;
	usage: Record<string, unknown>;
}
