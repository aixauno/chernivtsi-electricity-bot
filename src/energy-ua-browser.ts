import { energyUaGroups, parseEnergyUa, type Schedule } from './energy-ua';

const usageKey = 'energy-ua:browser-usage';
const intervalMs = 5 * 60_000;
const maxIntervalMs = 30 * 60_000;
const dailyBudgetMs = 8 * 60_000;
const reservationMs = 15_000;

type BrowserUsage = { utcDay: string; usedMs: number; lastAttempt: number; failures?: number };
type BrowserUsageStorage = Pick<DurableObjectStorage, 'transaction'>;

export async function readBrowserSchedule(
	browser: Pick<BrowserRun, 'quickAction'>,
	storage: BrowserUsageStorage,
	group: string,
	date: string,
	now: Date,
): Promise<Schedule | undefined> {
	const utcDay = now.toISOString().slice(0, 10);
	const lastAttempt = now.getTime();
	const reserved = await storage.transaction(async (transaction) => {
		const saved = await transaction.get<BrowserUsage>(usageKey);
		const previous = saved?.utcDay === utcDay ? saved : undefined;
		const failures = previous?.failures ?? 0;
		const delay = Math.min(maxIntervalMs, intervalMs * 2 ** Math.max(0, failures - 1));
		if (previous && lastAttempt - previous.lastAttempt < delay) return false;
		const usedMs = previous?.usedMs ?? 0;
		if (usedMs + reservationMs > dailyBudgetMs) return false;
		await transaction.put(usageKey, { utcDay, usedMs: usedMs + reservationMs, lastAttempt, failures });
		return true;
	});
	if (!reserved) return;

	let actualMs = reservationMs;
	let schedule: Schedule | undefined;
	try {
		const response = await browser.quickAction('content', {
			url: energyUaGroups + group,
			cacheTTL: 0,
			gotoOptions: { waitUntil: 'domcontentloaded', timeout: 8_000 },
			actionTimeout: 5_000,
			rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
		});
		const browserTime = response.headers.get('x-browser-ms-used');
		const reportedMs = Number(browserTime);
		if (browserTime && Number.isFinite(reportedMs) && reportedMs >= 0) actualMs = Math.ceil(reportedMs);
		if (!response.ok) throw new Error('Energy UA Browser Run returned HTTP ' + response.status);
		const { result } = await response.json<{ result?: unknown }>();
		if (typeof result !== 'string') throw new Error('Energy UA Browser Run did not return HTML.');
		schedule = parseEnergyUa(result, group, date);
		return schedule;
	} finally {
		await storage.transaction(async (transaction) => {
			const usage = await transaction.get<BrowserUsage>(usageKey);
			if (usage?.utcDay === utcDay) {
				await transaction.put(usageKey, {
					...usage,
					usedMs: usage.usedMs - reservationMs + actualMs,
					failures: schedule ? 0 : (usage.failures ?? 0) + 1,
				});
			}
		});
	}
}
