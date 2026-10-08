/**
 * Quota status-line row for the provider of the currently selected model.
 *
 * Renders one status entry — `commandcode ◷ 5hr: 4% · 7d: 33% · 36.3` — through
 * `ctx.ui.setStatus`, so it appears wherever the `status` segment sits in
 * `statusLine.leftSegments` / `rightSegments`.
 *
 * Data comes from `omp usage --json`: the same normalized UsageReports the
 * built-in `usage` segment reads, so omp's 5-minute usage cache and 24-hour
 * last-good retention apply. Only labels and window names come from config;
 * window ids, units and values are derived from the report.
 *
 * Overrides live in quota-status.json next to this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";


interface UsageAmountValue {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	unit: string;
}

interface UsageLimitValue {
	id: string;
	label?: string;
	window?: { id?: string; label?: string; durationMs?: number };
	amount: UsageAmountValue;
}

interface UsageReportValue {
	provider: string;
	fetchedAt: number;
	limits?: UsageLimitValue[];
}

interface ProviderSettings {
	label?: string;
	hidden?: boolean;
	windows?: string[];
	windowLabels?: Record<string, string>;
	extraLabels?: Record<string, string>;
}

interface Settings {
	refreshMs?: number;
	staleAfterMs?: number;
	warnAt?: number;
	criticalAt?: number;
	shortIcon?: string;
	providers?: Record<string, ProviderSettings>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalField(value: Record<string, unknown>, key: string, valid: (item: unknown) => boolean): boolean {
	return value[key] === undefined || valid(value[key]);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function isUsageAmount(value: unknown): value is UsageAmountValue {
	return isRecord(value)
		&& typeof value.unit === "string"
		&& optionalField(value, "used", item => typeof item === "number")
		&& optionalField(value, "limit", item => typeof item === "number")
		&& optionalField(value, "remaining", item => typeof item === "number")
		&& optionalField(value, "usedFraction", item => typeof item === "number");
}

function isUsageLimit(value: unknown): value is UsageLimitValue {
	if (!isRecord(value) || typeof value.id !== "string" || !isUsageAmount(value.amount)) return false;
	if (!optionalField(value, "label", item => typeof item === "string")) return false;
	if (value.window === undefined) return true;
	const window = value.window;
	return isRecord(window)
		&& optionalField(window, "id", item => typeof item === "string")
		&& optionalField(window, "label", item => typeof item === "string")
		&& optionalField(window, "durationMs", item => typeof item === "number");
}

function isUsageReport(value: unknown): value is UsageReportValue {
	return isRecord(value)
		&& typeof value.provider === "string"
		&& typeof value.fetchedAt === "number"
		&& optionalField(value, "limits", item => Array.isArray(item) && item.every(isUsageLimit));
}

function parseReports(value: unknown): UsageReportValue[] {
	if (!isRecord(value) || (value.reports !== undefined && (!Array.isArray(value.reports) || !value.reports.every(isUsageReport)))) {
		throw new TypeError("Invalid usage response");
	}
	return (value.reports ?? []) as UsageReportValue[];
}

function isProviderSettings(value: unknown): value is ProviderSettings {
	return isRecord(value)
		&& optionalField(value, "label", item => typeof item === "string")
		&& optionalField(value, "hidden", item => typeof item === "boolean")
		&& optionalField(value, "windows", item => Array.isArray(item) && item.every(entry => typeof entry === "string"))
		&& optionalField(value, "windowLabels", isStringRecord)
		&& optionalField(value, "extraLabels", isStringRecord);
}

function isSettings(value: unknown): value is Settings {
	return isRecord(value)
		&& optionalField(value, "refreshMs", item => typeof item === "number")
		&& optionalField(value, "staleAfterMs", item => typeof item === "number")
		&& optionalField(value, "warnAt", item => typeof item === "number")
		&& optionalField(value, "criticalAt", item => typeof item === "number")
		&& optionalField(value, "shortIcon", item => typeof item === "string")
		&& optionalField(value, "providers", item => isRecord(item) && Object.values(item).every(isProviderSettings));
}

function isCredits(value: unknown): value is { data: { total_credits: number; total_usage: number } } {
	return isRecord(value) && isRecord(value.data)
		&& typeof value.data.total_credits === "number"
		&& typeof value.data.total_usage === "number";
}

function isCommandCodeSummary(value: unknown): value is { totalMonthlyCredits?: number; totalCost?: number } {
	return isRecord(value)
		&& optionalField(value, "totalMonthlyCredits", item => typeof item === "number")
		&& optionalField(value, "totalCost", item => typeof item === "number");
}

function isCommandCodeCredits(value: unknown): value is { credits: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number } } {
	if (!isRecord(value) || !isRecord(value.credits)) return false;
	return optionalField(value.credits, "monthlyCredits", item => typeof item === "number")
		&& optionalField(value.credits, "purchasedCredits", item => typeof item === "number")
		&& optionalField(value.credits, "freeCredits", item => typeof item === "number");
}


/** Credit balance for providers omp ships no usage provider for. */
const CREDIT_ENDPOINTS: Record<string, string> = {
	openrouter: "https://openrouter.ai/api/v1/credits",
};

const STATUS_KEY = "quota";
const REFRESH_MS = 300_000;
const STALE_AFTER_MS = 600_000;
const WARN_AT = 0.75;
const CRITICAL_AT = 0.9;
const SHORT_ICON = "◷";

/** Window ids whose duration the provider does not report. */
const IMPLICIT_WINDOW_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"5h": 5 * 60 * 60 * 1000,
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	"1mo": 30 * 24 * 60 * 60 * 1000,
	"1d": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Display names for the window ids providers actually report. */
const WINDOW_LABELS: Record<string, string> = {
	"1h": "1hr",
	"5h": "5hr",
	monthly: "mo",
	"30d": "mo",
	"1mo": "mo",
	hourly: "hr",
	"1d": "1d",
	daily: "1d",
	"7d": "7d",
	weekly: "wk",
	monthly: "mo",
};

function loadConfig(): Settings {
	try {
		const path = join(dirname(fileURLToPath(import.meta.url)), "..", "quota-status.json");
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isSettings(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Mirrors core's `resolveUsedFraction` precedence so numbers match `omp usage`. */
function usedFraction(amount: UsageAmountValue): number | undefined {
	if (typeof amount.usedFraction === "number") return amount.usedFraction;
	if (typeof amount.used === "number" && amount.unit === "percent") return amount.used / 100;
	if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (typeof amount.remaining === "number" && typeof amount.limit === "number" && amount.limit > 0) {
		return 1 - amount.remaining / amount.limit;
	}
	return undefined;
}

function formatPercent(fraction: number): string {
	const pct = Math.max(fraction, 0) * 100;
	return Math.abs(pct - Math.round(pct)) < 0.05 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

function trimNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

/**
 * Severity marker. The status segment renders every status in one accent colour
 * and `sanitizeStatusText` strips ANSI before that, so per-window colour is not
 * reachable through this seam — the marker carries the escalation instead.
 */
function severityMarker(fraction: number, config: Settings): string {
	if (fraction >= (config.criticalAt ?? CRITICAL_AT)) return "!";
	if (fraction >= (config.warnAt ?? WARN_AT)) return "▲";
	return "";
}

function windowToken(limit: UsageLimitValue, config: Settings, override: ProviderSettings | undefined): string | undefined {
	const fraction = usedFraction(limit.amount);
	if (fraction === undefined) return undefined;

	const id = limit.window?.id?.toLowerCase() ?? "";
	const name = override?.windowLabels?.[limit.window?.id ?? ""] ?? WINDOW_LABELS[id] ?? limit.window?.id;
	if (!name) return undefined;

	const durationMs = limit.window?.durationMs ?? IMPLICIT_WINDOW_MS[id];
	const isShort = durationMs !== undefined && durationMs <= 12 * 60 * 60 * 1000;
	const icon = isShort ? (config.shortIcon ?? SHORT_ICON) : "";
	return `${icon ? `${icon} ` : ""}${name}: ${formatPercent(fraction)}${severityMarker(fraction, config)}`;
}

/** A windowless bucket (credit balance, key cap) has no percentage to show. */
function plainValue(limit: UsageLimitValue): string | undefined {
	const { amount } = limit;
	if (typeof amount.remaining === "number") {
		return amount.unit === "usd" ? `$${trimNumber(amount.remaining)}` : trimNumber(amount.remaining);
	}
	if (typeof amount.used === "number" && typeof amount.limit === "number") {
		return `${trimNumber(amount.used)}/${trimNumber(amount.limit)}`;
	}
	return undefined;
}

function renderReport(report: UsageReportValue, config: Settings, stale: boolean): string | undefined {
	const override = config.providers?.[report.provider];
	if (override?.hidden) return undefined;

	const parts: string[] = [];
	for (const limit of report.limits ?? []) {
		if (report.provider === "commandcode" && limit.id.endsWith(":balance")) continue;
		if (override?.windows && !override.windows.some(w => w === limit.window?.id || limit.id.endsWith(`:${w}`))) {
			continue;
		}
		if (limit.window) {
			parts.push(windowToken(limit, config, override) ?? "");
			continue;
		}
		// Windowless buckets (credit balance, key cap) have no window name, so the
		// label comes from `extraLabels`, keyed by full limit id or its suffix.
		const value = plainValue(limit);
		if (!value) continue;
		const name = override?.extraLabels?.[limit.id] ?? override?.extraLabels?.[limit.id.split(":").pop() ?? ""];
		parts.push(name ? `${name}: ${value}` : value);
	}

	const body = parts.filter(Boolean).join(" · ");
	if (!body) return undefined;
	return `${body}${stale ? "?" : ""}`;
}

/** Providers with no omp usage provider still get a balance, read via the CLI. */
async function fetchCreditBalance(pi: ExtensionAPI, provider: string): Promise<number | undefined> {
	const endpoint = CREDIT_ENDPOINTS[provider];
	if (!endpoint) return undefined;
	try {
		const token = await pi.exec("omp", ["token", provider], { timeout: 10_000 });
		const apiKey = token.stdout.trim();
		if (token.code !== 0 || !apiKey) return undefined;

		const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
		if (!response.ok) return undefined;

		const parsed: unknown = await response.json();
		if (!isCredits(parsed)) return undefined;
		return parsed.data.total_credits - parsed.data.total_usage;
	} catch {
		return undefined;
	}
}


/**
 * CommandCode publishes no monthly window: `/alpha/billing/credits` carries
 * only fiveHour and weekly, so the monthly figure is derived from monthly spend
 * against the total credit pool. Returns a used fraction.
 */
async function fetchCommandCodeMonthly(pi: ExtensionAPI): Promise<number | undefined> {
	try {
		const token = await pi.exec("omp", ["token", "commandcode"], { timeout: 10_000 });
		const authorization = token.stdout.trim();
		if (token.code !== 0 || !authorization) return undefined;

		const headers = { Authorization: `Bearer ${authorization}`, Accept: "application/json" };
		const [summaryRes, creditsRes] = await Promise.all([
			fetch("https://api.commandcode.ai/alpha/usage/summary", { headers }),
			fetch("https://api.commandcode.ai/alpha/billing/credits", { headers }),
		]);
		if (!summaryRes.ok || !creditsRes.ok) return undefined;

		const [summaryValue, creditsValue]: unknown[] = await Promise.all([summaryRes.json(), creditsRes.json()]);
		if (!isCommandCodeSummary(summaryValue) || !isCommandCodeCredits(creditsValue)) return undefined;
		const summary = summaryValue;
		const credits = creditsValue;

		const spent = summary.totalMonthlyCredits ?? summary.totalCost ?? 0;
		const pool =
			(credits.credits.monthlyCredits ?? 0) +
			(credits.credits.purchasedCredits ?? 0) +
			(credits.credits.freeCredits ?? 0) +
			spent;
		return pool > 0 ? spent / pool : undefined;
	} catch {
		return undefined;
	}
}

export default function quotaStatus(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Headless runs (`omp usage --json`) load extensions too. Rendering needs a
		// TUI, and skipping them keeps this extension from spawning itself.
		if (!ctx.hasUI) return;

		const config = loadConfig();
		const staleAfterMs = config.staleAfterMs ?? STALE_AFTER_MS;
		let reports: UsageReportValue[] = [];
		let lastDataAt = 0;
		/** provider id → remaining balance, for providers omp has no usage provider for. */
		const credits = new Map<string, number>();
		/** provider id → monthly used fraction, for windows the provider never publishes. */
		const monthly = new Map<string, number>();

		const run = async (): Promise<void> => {
			try {
				const result = await pi.exec("omp", ["usage", "--json"], { timeout: 20_000 });
				reports = parseReports(JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))));
				if (reports.some(report => (report.limits?.length ?? 0) > 0)) lastDataAt = Date.now();
			} catch {
				return; // Keep the last rendered values rather than blanking the line.
			}
			for (const provider of Object.keys(CREDIT_ENDPOINTS)) {
				// A real usage report always wins over the balance fallback.
				if (reports.some(report => report.provider === provider)) continue;
				const balance = await fetchCreditBalance(pi, provider);
				if (balance === undefined) credits.delete(provider);
				else {
					credits.set(provider, balance);
					lastDataAt = Date.now();
				}
			}
			const commandCodeMonthly = await fetchCommandCodeMonthly(pi);
			if (commandCodeMonthly === undefined) monthly.delete("commandcode");
			else monthly.set("commandcode", commandCodeMonthly);
		};

		// Rendering is cheap, so it runs on its own cadence: switching models must
		// change the row immediately, without re-fetching usage every tick.
		const render = (): void => {
			const provider = ctx.model?.provider;
			if (!provider) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const report = reports.find(r => r.provider === provider);
			if (report) {
				const row = renderReport(report, config, Date.now() - lastDataAt > staleAfterMs);
				const fraction = monthly.get(provider);
				// CommandCode publishes no monthly window; append the derived one.
				const derived = fraction === undefined || row?.includes(" mo: ") ? undefined : `mo: ${formatPercent(fraction)}`;
				const parts = [row, derived].filter(Boolean);
				ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
				return;
			}

			// No usage provider for this one (OpenRouter): show the credit balance.
			const balance = credits.get(provider);
			ctx.ui.setStatus(STATUS_KEY, balance === undefined ? undefined : `$${trimNumber(balance)}`);
		};

		await run();
		render();
		const usageTimer = ctx.setInterval(() => void run().then(render), config.refreshMs ?? REFRESH_MS);
		const renderTimer = ctx.setInterval(render, 5_000);
		pi.on("session_shutdown", () => {
			ctx.clearTimer(usageTimer);
			ctx.clearTimer(renderTimer);
		});
	});
}