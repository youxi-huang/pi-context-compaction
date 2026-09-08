import type { Api, Model } from "@earendil-works/pi-ai";
import { createEventBus } from "../../core/event-bus.ts";
import { loadExtensionFromFactory } from "../../core/extensions/loader.ts";
import type { LoadExtensionsResult } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type {
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
} from "../../core/resource-loader.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { readMemoryConfig } from "./config.ts";
import { MemoryController, type MemoryHost } from "./controller.ts";
import { memoryExtension } from "./extension.ts";
import { CONTEXT_MEMORY_PATH } from "./identity.ts";
import { assertResidentExtensions, registerResident } from "./policy.ts";

/** A transparent loader adapter: ordinary resource filters run before the resident is appended. */
class MemoryResourceLoader implements ResourceLoader {
	private readonly base: ResourceLoader;
	private readonly host: MemoryHost;
	private readonly cwd: string;
	private readonly controller: MemoryController;
	private result?: LoadExtensionsResult;

	constructor(base: ResourceLoader, cwd: string, host: MemoryHost) {
		this.base = base;
		this.cwd = cwd;
		this.host = host;
		this.controller = new MemoryController(host);
	}

	async install(model?: Model<Api>): Promise<void> {
		const base = this.base.getExtensions();
		const resident = await loadExtensionFromFactory(
			memoryExtension(this.host, this.controller),
			this.cwd,
			createEventBus(),
			base.runtime,
			CONTEXT_MEMORY_PATH,
		);
		registerResident(resident);
		const result = { ...base, extensions: [...base.extensions, resident] };
		assertResidentExtensions(result.extensions);
		this.result = result;
		this.controller.refresh(model);
	}

	getExtensions(): LoadExtensionsResult {
		if (!this.result) throw new Error("CONTEXT_RESIDENT_NOT_INITIALIZED");
		return this.result;
	}
	getSkills() {
		return this.base.getSkills();
	}
	getPrompts() {
		return this.base.getPrompts();
	}
	getThemes() {
		return this.base.getThemes();
	}
	getAgentsFiles() {
		return this.base.getAgentsFiles();
	}
	getSystemPrompt() {
		return this.base.getSystemPrompt();
	}
	getSystemPromptSource() {
		return this.base.getSystemPromptSource();
	}
	getAppendSystemPrompt() {
		return this.base.getAppendSystemPrompt();
	}
	getAppendSystemPromptSources() {
		return this.base.getAppendSystemPromptSources();
	}
	extendResources(paths: ResourceExtensionPaths): void {
		this.base.extendResources(paths);
	}
	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		await this.base.reload(options);
		await this.install();
	}
}

export async function withContextMemory(
	base: ResourceLoader,
	options: {
		cwd: string;
		agentDir: string;
		session: SessionManager;
		settings: SettingsManager;
		runtime: ModelRuntime;
		model?: Model<Api>;
	},
): Promise<ResourceLoader> {
	const loader = new MemoryResourceLoader(base, options.cwd, {
		config: readMemoryConfig(options.agentDir),
		session: options.session,
		runtime: options.runtime,
		setCompaction: (compaction) => options.settings.applyOverrides({ compaction }),
	});
	await loader.install(options.model);
	return loader;
}
