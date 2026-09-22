/** A small in-process pool. Admission and accounting remain in the shared ledger. */
export async function boundedWorkers<T>(
	items: readonly T[],
	concurrency: number,
	stopped: () => boolean,
	work: (item: T) => Promise<void>,
): Promise<void> {
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
		throw new Error("EVAL_INVALID_CONCURRENCY");
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (!stopped()) {
				const index = next++;
				if (index >= items.length) return;
				await work(items[index]);
			}
		}),
	);
}
export function gate() {
	let release: (ready: boolean) => void = () => {};
	const promise = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
