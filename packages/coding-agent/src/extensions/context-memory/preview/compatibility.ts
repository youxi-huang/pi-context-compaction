/** Exact official hosts validated for the independent extension, newest first. */
export const SUPPORTED_PI_VERSIONS: readonly string[] = Object.freeze(["1.2.0", "1.1.0"]);
export const PRIMARY_PI_VERSION = SUPPORTED_PI_VERSIONS[0];
export const SUPPORTED_PI_LABEL = SUPPORTED_PI_VERSIONS.join(" or ");

export function supportsPi(version: string): boolean {
	return SUPPORTED_PI_VERSIONS.includes(version);
}
