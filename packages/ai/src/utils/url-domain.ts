/** Match an HTTP(S) endpoint's hostname, never domain-like text in its path or user info. */
export function isUrlFromDomain(url: string, domain: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
		const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
		return hostname === domain || hostname.endsWith(`.${domain}`);
	} catch {
		return false;
	}
}
