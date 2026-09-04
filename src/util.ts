import { spawn } from "node:child_process";

/**
 * Expand `$VAR`, `${VAR}` and `${VAR:-default}` references in a string using process.env.
 * `$$` yields a literal `$`.
 */
export function expandEnv(value: string, extraEnv: Record<string, string> = {}): string {
	const env = { ...process.env, ...extraEnv };
	return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, def, bare) => {
		if (match === "$$") return "$";
		const name = braced ?? bare;
		const found = env[name];
		if (found !== undefined && found !== "") return found;
		if (def !== undefined) return def;
		return "";
	});
}

export function expandEnvRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(record)) out[k] = expandEnv(v);
	return out;
}

/** Sanitize a name into something all LLM providers accept for tool names. */
export function sanitizeToolName(name: string): string {
	let cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	if (!cleaned) cleaned = "tool";
	if (!/^[A-Za-z_]/.test(cleaned)) cleaned = `_${cleaned}`;
	return cleaned.slice(0, 64);
}

/** Simple glob match supporting `*` and `?` only. */
export function globMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`).test(value);
}

export function openInBrowser(url: string): void {
	try {
		let cmd: string;
		let args: string[];
		if (process.platform === "win32") {
			cmd = "cmd";
			args = ["/c", "start", "", url.replace(/&/g, "^&")];
		} else if (process.platform === "darwin") {
			cmd = "open";
			args = [url];
		} else {
			cmd = "xdg-open";
			args = [url];
		}
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// ignore — caller displays the URL as a fallback
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	if (!ms || ms <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
