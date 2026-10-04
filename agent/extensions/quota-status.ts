/**
 * Quota status line segment: one status entry per authenticated provider,
 * rendered as `label <icon> 18% · <icon> 31%` in the status line.
 *
 * Data comes from `omp usage --json`, the same normalized UsageReports the
 * built-in `usage` segment reads, so omp's 5-minute usage cache and last-good
 * retention apply. Only the short label is configuration; window ids, units and
 * reset times all come from the provider's own report.
 *
 * Overrides live in quota-status.json next to this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const Amount = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	unit: "string",
});

const Limit = type({
	id: "string",
	"label?": "string",
	"window?": type({ "id?": "string", "label?": "string", "durationMs?": "number" }),
	amount: Amount,
});

const Report = type({
	provider: "string",
	fetchedAt: "number",
	"limits?": Limit.array(),
});

const UsageResponse = type({ reports: Report.array().optional() });

const ProviderOverride = type({
	"label?": "string",
	"order?": "number",
	"hidden?": "boolean",
	"windows?": "string[]",
});

const Config = type({
	"refreshMs?": "number",
	"staleAfterMs?": "number",
	"shortIcon?": "string",
	"longIcon?": "string",
	"icons?": "string",
	providers: type.Record("string", ProviderOverride).optional(),
});

type UsageLimit = ReturnType<typeof Limit.infer>;
type UsageReport = ReturnType<typeof Report.infer>;
type Settings = ReturnType<typeof Config.infer>;

const REFRESH_MS = 300_000;
const STALE_AFTER_MS = 600_000;
const SHORT_WINDOW_MS = 12 * 60 * 60 * 1000;
const SHORT_ICON = "◷";
const LONG_ICON = "📅";

/** Window ids whose duration the provider does not report. */
const IMPLICIT_WINDOW_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"5h": 5 * 60 * 60 * 1000,
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	"1d": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 30 * 24 * 60 * 60 * 1000,
};

function loadConfig(): Settings {
	try {
		const path = join(dirname(fileURLToPath(import.meta.url)), "..", "quota-status.json");
		return Config.assert(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/** Mirrors core's `resolveUsedFraction` precedence so numbers match `omp usage`. */
function usedFraction(amount: ReturnType<typeof Amount.infer>): number | undefined {
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

/** Three call sites share this rounding, so it stays one helper. */
function trimNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

/** A windowless bucket (credit balance, key cap) has no percentage to show. */
function renderWindowless(limit: UsageLimit): string | undefined {
	const { amount } = limit;
	if (typeof amount.remaining === "number") {
		return amount.unit === "usd" ? `$${trimNumber(amount.remaining)}` : trimNumber(amount.remaining);
	}
	if (typeof amount.used === "number" && typeof amount.limit === "number") {
		return `${trimNumber(amount.used)}/${trimNumber(amount.limit)}`;
	}
	return undefined;
}

function renderWindow(limit: UsageLimit, config: Settings): string | undefined {
	const fraction = usedFraction(limit.amount);
	if (fraction === undefined) return undefined;

	const durationMs =
		limit.window?.durationMs ?? IMPLICIT_WINDOW_MS[limit.window?.id?.toLowerCase() ?? ""];
	const text = `${Math.round(Math.max(fraction, 0) * 100)}%`;
	if (config.icons === "text") {
		return `${limit.window?.id ?? limit.window?.label ?? limit.label ?? ""} ${text}`.trim();
	}
	const icon =
		typeof durationMs === "number" && durationMs > SHORT_WINDOW_MS
			? (config.longIcon ?? LONG_ICON)
			: (config.shortIcon ?? SHORT_ICON);
	return `${icon} ${text}`;
}

function renderProvider(report: UsageReport, config: Settings, stale: boolean): string | undefined {
	const override = config.providers?.[report.provider];
	if (override?.hidden) return undefined;

	const parts: string[] = [];
	for (const limit of report.limits ?? []) {
		if (override?.windows && !override.windows.some(w => w === limit.window?.id || limit.id.endsWith(`:${w}`))) {
			continue;
		}
		parts.push((limit.window ? renderWindow(limit, config) : renderWindowless(limit)) ?? "");
	}

	const body = parts.filter(Boolean).join(" · ");
	if (!body) return undefined;
	// The status segment collapses runs of spaces, so staleness rides on the label.
	return `${override?.label ?? report.provider}${stale ? "?" : ""} ${body}`;
}

export default function quotaStatus(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Headless runs (`omp usage --json`) load extensions too. Rendering needs a
		// TUI, and skipping them keeps this extension from spawning itself.
		if (!ctx.hasUI) return;

		const config = loadConfig();
		const staleAfterMs = config.staleAfterMs ?? STALE_AFTER_MS;
		/** provider id → epoch ms of the last report that actually carried data. */
		const lastDataAt = new Map<string, number>();
		/** Status keys written by the previous run, so vanished providers get cleared. */
		const publishedKeys = new Set<string>();

		const run = async (): Promise<void> => {
			let reports: UsageReport[];
			try {
				const result = await pi.exec("omp", ["usage", "--json"], { timeout: 20_000 });
				const parsed = UsageResponse(JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))));
				reports = parsed.reports ?? [];
			} catch {
				return; // Keep the last rendered values rather than blanking the line.
			}

			const now = Date.now();
			const ordered = [...reports].sort(
				(a, b) => (config.providers?.[a.provider]?.order ?? 100) - (config.providers?.[b.provider]?.order ?? 100),
			);
			const liveKeys = new Set<string>();
			for (const [index, report] of ordered.entries()) {
				// Only a report that actually carries limits counts as fresh data.
				if ((report.limits?.length ?? 0) > 0) lastDataAt.set(report.provider, now);
				// Zero-padded so the status segment's lexical key order matches `order`.
				const key = `quota:${String(index).padStart(2, "0")}:${report.provider}`;
				liveKeys.add(key);
				ctx.ui.setStatus(
					key,
					renderProvider(report, config, now - (lastDataAt.get(report.provider) ?? now) > staleAfterMs),
				);
			}
			for (const key of publishedKeys) {
				if (!liveKeys.has(key)) ctx.ui.setStatus(key, undefined);
			}
			publishedKeys.clear();
			for (const key of liveKeys) publishedKeys.add(key);
		};

		await run();
		const timer = setInterval(() => void run(), config.refreshMs ?? REFRESH_MS);
		pi.on("session_shutdown", () => ctx.clearTimer(timer));
	});
}