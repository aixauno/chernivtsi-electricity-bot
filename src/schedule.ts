import { defaultAlerts, formatMessage, messages, type AlertPreferences, type Language } from './messages';
import { kyiv, readEnergyUa, scheduleDate, type Day, type Schedule } from './energy-ua';
import { readMirror } from './schedule-backup';

type ScheduleSource = 'energy-ua' | 'mirror';
export type Snapshot = { schedule: Schedule; warning?: string; warnings?: string[]; observed?: Partial<Record<ScheduleSource, Day>> };
export type VerifiedSchedule = {
	schedule: Schedule;
	source?: ScheduleSource;
};

export async function loadSchedule(
	group: string,
	now: Date,
	readInBrowser?: (date: string) => Promise<Schedule | undefined>,
): Promise<VerifiedSchedule> {
	const date = scheduleDate(now);
	try {
		return { schedule: await readEnergyUa(group, date), source: 'energy-ua' };
	} catch (error) {
		try {
			const schedule = await readInBrowser?.(date);
			if (schedule) return { schedule, source: 'energy-ua' };
		} catch (browserError) {
			console.warn('Energy UA Browser Run failed', browserError instanceof Error ? browserError.message : browserError);
		}
		try {
			return { schedule: await readMirror(group, date), source: 'mirror' };
		} catch (backupError) {
			console.warn('Schedule backup failed', backupError instanceof Error ? backupError.message : backupError);
			throw error;
		}
	}
}

type Status = keyof typeof messages.en.status;

function time(slot: number): string {
	const hour = String(Math.floor(slot / 2)).padStart(2, '0');
	return hour + (slot % 2 === 0 ? ':00' : ':30');
}

function range(start: number, end: number): string {
	return `<b>${time(start)}–${time(end)}</b>`;
}

function clockMinute(now: Date): number {
	const [, clock] = kyiv.format(now).split(' ');
	const [hours, minutes] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

type CardDetails = { checkedAt?: number; stale?: Schedule };

export function currentSchedule(
	result: VerifiedSchedule | undefined,
	now: Date,
	group: string,
	language: Language,
	details: CardDetails = {},
): string {
	const copy = messages[language];
	const date = scheduleDate(now);
	const schedule = result?.schedule ?? details.stale;
	const today = schedule?.today.date === date ? schedule.today : undefined;
	const minute = clockMinute(now);
	const slot = Math.floor(minute / 30);
	const scheduled = today ? outageIntervals(today) : [];
	const current = scheduled.find(({ start, end }) => start <= slot && end > slot);
	const status = today ? copy.status[today.slots[slot] as Status] : copy.unknownStatus;
	const lines = [`· <b>${copy.nowShort}</b>`, current ? `${status} · ${range(current.start, current.end)}` : status];
	const upcoming = scheduled.filter(({ start }) => start > slot);
	const next: string[] = [];
	if (current && today?.slots[current.end] === '1') next.push(`${copy.status['1']} · <b>${time(current.end)}</b>`);
	for (const { start, end, status } of upcoming) {
		const minutes = start * 30 - minute;
		const countdown = !next.length && status === '0' && minutes <= defaultAlerts.minutes ? ` · <i>${copy.inMinutes(minutes)}</i>` : '';
		next.push(`${copy.outageLabels[status]} · ${range(start, end)}${countdown}`);
	}
	if (!today) next.push(copy.unknownTransition);
	if (next.length) lines.push(`· <b>${copy.nextShort}</b>`, ...next);
	else if (!current) lines.push(scheduled.length ? copy.noRemainingOutages : copy.noOutages);
	if (details.checkedAt !== undefined) {
		const [, updatedTime] = kyiv.format(new Date(details.checkedAt)).split(' ');
		lines.push(`<i>${result ? copy.updatedAt : copy.lastUpdate}</i> <b>${updatedTime}</b>`);
	}
	return formatMessage(group, language, lines.join('\n'), copy.todayTitle);
}

type Interval = { start: number; end: number; status: '0' | '3' };

function outageIntervals(day: Day): Interval[] {
	const intervals: Interval[] = [];
	for (let start = 0; start < day.slots.length;) {
		const status = day.slots[start];
		let end = start + 1;
		while (day.slots[end] === status) end++;
		if (status === '0' || status === '3') intervals.push({ start, end, status });
		start = end;
	}
	return intervals;
}

function describeUpdate(before: Day, after: Day, language: Language, currentSlot: number): string[] {
	const copy = messages[language];
	const changes = new Map<string, string[]>();
	for (let start = 0; start < after.slots.length;) {
		const oldStatus = before.slots[start] as Status;
		const newStatus = after.slots[start] as Status;
		let end = start + 1;
		while (before.slots[end] === oldStatus && after.slots[end] === newStatus) end++;
		if (oldStatus !== newStatus && end > currentSlot) {
			const transition = `${copy.status[oldStatus]} → ${copy.status[newStatus]}`;
			const ranges = changes.get(transition) ?? [];
			ranges.push(range(start, end));
			changes.set(transition, ranges);
		}
		start = end;
	}
	return Array.from(changes, ([transition, ranges]) => `${ranges.join(', ')} · ${transition}`);
}

export function notification(
	result: VerifiedSchedule,
	now: Date,
	group: string,
	language: Language,
	previous?: Snapshot,
	preferences: AlertPreferences = defaultAlerts,
) {
	const copy = messages[language];
	const messagesToSend: { text: string; snapshot: Snapshot }[] = [];
	const old = previous?.schedule.today;
	const source = result.source;
	const previousBackup = previous?.observed?.mirror;
	const reported = result.schedule.today;
	// An unchanged backup must not override the latest Energy UA schedule.
	const day =
		source === 'mirror' && old?.date === reported.date && previousBackup?.date === reported.date && previousBackup.slots === reported.slots
			? old
			: reported;
	const schedule = { today: day };
	const minute = clockMinute(now);
	const slot = Math.floor(minute / 30);
	const slots = day.slots;
	let next = slot + 1;
	while (next < slots.length && (slots[next] === slots[next - 1] || slots[next] === '3')) next++;
	const status = slots[next];
	const minutes = next * 30 - minute;
	const warnings = old?.date === day.date ? [...(previous?.warnings ?? (previous?.warning ? [previous.warning] : []))] : [];
	let snapshot: Snapshot = {
		schedule,
		...(warnings.length > 0 && { warnings }),
		...(source && { observed: { ...previous?.observed, [source]: reported } }),
	};
	if (preferences.updates) {
		const changes = old?.date === day.date ? describeUpdate(old, day, language, slot) : [`· <b>${copy.initial}</b>`];
		if (old?.date === day.date && changes.length) changes.unshift(`· <b>${copy.updated}</b>`);
		if (changes.length) {
			messagesToSend.push({ text: formatMessage(group, language, changes.join('\n'), copy.updateTitle), snapshot });
		}
	}
	if ((status === '0' || status === '1') && minutes <= preferences.minutes) {
		const clock = time(next);
		const key = day.date + ' ' + clock + ' · ';
		const enabled = status === '1' ? preferences.return : preferences.cutoff;
		const legacyLabels = { '0': '🔴 Corte previsto', '1': '🟢 Suministro previsto' };
		if (enabled && !warnings.includes(key + status) && !warnings.includes(key + legacyLabels[status])) {
			const body = `· <b>${clock}</b> · ${copy.events[status]} · <i>${copy.inMinutes(minutes)}</i>`;
			snapshot = { ...snapshot, warnings: [...warnings, key + status] };
			messagesToSend.push({ text: formatMessage(group, language, body, copy.reminderTitles[status]), snapshot });
		}
	}
	return { snapshot, messages: messagesToSend };
}
