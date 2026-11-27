import { defaultAlerts, formatMessage, messages, type AlertPreferences, type Language } from './messages';
import { kyiv, readEnergyUa, scheduleDate, type Day, type Schedule } from './energy-ua';
import { readMirror } from './schedule-backup';

export type Snapshot = { schedule: Schedule; warning?: string; warnings?: string[] };
export type VerifiedSchedule = {
	schedule: Schedule;
	source?: 'energy-ua' | 'mirror';
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

const legacyReminderLabels = { '0': '🔴 Corte previsto', '1': '🟢 Suministro previsto' };

function reminderStatus(slots: string, slot: number) {
	const status = slots[slot];
	if ((status === '0' || status === '1') && status !== slots[slot - 1]) return status;
}

function reminderKey(day: Day, slot: number): string {
	return day.date + ' ' + time(slot) + ' · ';
}

function retainWarnings(day: Day, warnings: string[]): string[] {
	const retained: string[] = [];
	for (let slot = 1; slot < day.slots.length; slot++) {
		const status = reminderStatus(day.slots, slot);
		if (!status) continue;
		const key = reminderKey(day, slot);
		if (warnings.includes(key + status) || warnings.includes(key + legacyReminderLabels[status])) retained.push(key + status);
	}
	return retained;
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
	const { schedule } = result;
	const day = schedule.today;
	const sameDay = old?.date === day.date;
	const changed = sameDay && old.slots !== day.slots;
	const sent = sameDay ? (previous?.warnings ?? (previous?.warning ? [previous.warning] : [])) : [];
	const warnings = changed && sent.length ? retainWarnings(day, sent) : sent;
	const minute = clockMinute(now);
	const slot = Math.floor(minute / 30);
	let snapshot: Snapshot = {
		schedule,
		...(warnings.length > 0 && { warnings }),
	};
	if (preferences.updates && (!sameDay || changed)) {
		const changes = sameDay ? describeUpdate(old, day, language, slot) : [];
		if (!sameDay || changes.length) {
			const heading = sameDay ? copy.updated : copy.initial;
			const body = [`· <b>${heading}</b>`, ...changes].join('\n');
			messagesToSend.push({ text: formatMessage(group, language, body, copy.updateTitle), snapshot });
		}
	}
	for (let next = slot + 1; next < day.slots.length && next * 30 - minute <= preferences.minutes; next++) {
		const status = reminderStatus(day.slots, next);
		if (!status) continue;
		const key = reminderKey(day, next);
		const enabled = status === '1' ? preferences.return : preferences.cutoff;
		if (enabled && !warnings.includes(key + status) && !warnings.includes(key + legacyReminderLabels[status])) {
			const minutes = next * 30 - minute;
			const body = `· <b>${time(next)}</b> · ${copy.events[status]} · <i>${copy.inMinutes(minutes)}</i>`;
			snapshot = { ...snapshot, warnings: [...warnings, key + status] };
			messagesToSend.push({ text: formatMessage(group, language, body, copy.reminderTitles[status]), snapshot });
		}
		break;
	}
	return { snapshot, messages: messagesToSend };
}
