import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { transportErrorChain } from "./diagnostics.ts";

/** Report only known guard names/booleans and proxy variable names, never their values. */
export function environmentSnapshot(
	env: NodeJS.ProcessEnv = process.env,
	execArgv: readonly string[] = process.execArgv,
	fetchFunction: typeof globalThis.fetch = globalThis.fetch,
) {
	const options = `${execArgv.join(" ")} ${env.NODE_OPTIONS ?? ""}`;
	const source = Function.prototype.toString.call(fetchFunction);
	const guards = {
		"deny-network": /deny-network\.(?:mjs|[cm]?js|ts)/.test(options) || source.includes("EVAL_NETWORK_FORBIDDEN"),
		PI_OFFLINE: env.PI_OFFLINE === "1",
		"named-fetch-guard": /denied|blocked|guard|mock/i.test(fetchFunction.name),
		"other-import-or-require-hook": /(?:--import|--require|(?:^|\s)-r(?:\s|=))/.test(options),
	};
	return {
		guards,
		proxyEnvironmentVariables: Object.keys(env)
			.filter((name) =>
				/^(?:(?:https?|all|no)_proxy|node_use_env_proxy|global_agent_(?:http_proxy|https_proxy|no_proxy))$/i.test(
					name,
				),
			)
			.sort(),
		detectionScope:
			"Known guard markers and preload flags only; arbitrary wrappers cannot be exhaustively identified.",
	};
}
export function recordStartupEnvironment() {
	const environment = environmentSnapshot();
	console.log(JSON.stringify({ type: "live-startup-environment", environment }));
	return environment;
}
export interface NetworkProbes {
	lookup: (host: string) => Promise<{ address: string; family: number }[]>;
	connect: (address: string, family: number, port: number) => Promise<void>;
}
const probes: NetworkProbes = {
	lookup: (host) => lookup(host, { all: true }),
	connect: (address, family, port) =>
		new Promise<void>((resolve, reject) => {
			const socket = connect({ host: address, family, port });
			const finish = (error?: Error) => {
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(Object.assign(new Error("TCP connection timed out"), { code: "ETIMEDOUT" })),
				5000,
			);
			socket.once("error", finish);
			socket.once("connect", () => finish());
		}),
};
/** One DNS lookup and one TCP connection, no TLS/HTTP bytes or provider credentials. */
export async function networkSelfCheck(io: NetworkProbes = probes) {
	const host = "chatgpt.com",
		port = 443;
	let addresses: { address: string; family: number }[];
	try {
		addresses = await io.lookup(host);
		if (!addresses.length) throw new Error("DNS returned no addresses");
	} catch (error) {
		return {
			host,
			port,
			at: new Date().toISOString(),
			ok: false,
			dns: { ok: false, error: transportErrorChain(error) },
			tcp: { skipped: true },
			providerRequests: 0,
		};
	}
	try {
		await io.connect(addresses[0].address, addresses[0].family, port);
		return {
			host,
			port,
			at: new Date().toISOString(),
			ok: true,
			dns: { ok: true, addresses },
			tcp: { ok: true, address: addresses[0].address },
			providerRequests: 0,
		};
	} catch (error) {
		return {
			host,
			port,
			at: new Date().toISOString(),
			ok: false,
			dns: { ok: true, addresses },
			tcp: { ok: false, address: addresses[0].address, error: transportErrorChain(error) },
			providerRequests: 0,
		};
	}
}
