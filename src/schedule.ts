import { defaultAlerts, formatMessage, messages, type AlertPreferences, type Language } from './messages';
import { kyiv, readEnergyUa, scheduleDate, type Day, type Schedule } from './energy-ua';
import { readMirror } from './schedule-backup';

type ScheduleSource = 'energy-ua' | 'mirror';
export type Snapshot = { schedule: Schedule; warning?: string; observed?: Partial<Record<ScheduleSource, Day>> };
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

const dateFormats = {
	en: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }),
	uk: new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }),
};

function time(slot: number): string {
	const hour = String(Math.floor(slot / 2)).padStart(2, '0');
	return hour + (slot % 2 === 0 ? ':00' : ':30');
}

function describe(day: Day, language: Language, currentSlot = 0): string {
	const copy = messages[language];
	const scheduled = outageIntervals(day);
	const intervals = scheduled
		.filter(({ end }) => end > currentSlot)
		.map(({ start, end, status }) => `${status === '0' ? '−' : '~'} <b>${time(start)}–${time(end)}</b> · ${copy.status[status]}`);
	const date = dateFormats[language].format(new Date(day.date)).replace(',', '');
	const empty = scheduled.length ? copy.noRemainingOutages : copy.noOutages;
	return `<b>${date.toUpperCase()}</b> · <i>${copy.localTime}</i>\n${intervals.join('\n') || empty}`;
}

function clockMinute(now: Date): number {
	const [, clock] = kyiv.format(now).split(' ');
	const [hours, minutes] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

export function currentSchedule(result: VerifiedSchedule, now: Date, group: string, language: Language): string {
	const copy = messages[language];
	const day = result.schedule.today;
	const { slots } = day;
	const start = Math.floor(clockMinute(now) / 30);
	const status = slots[start] as Status;
	let next = start + 1;
	while (next < slots.length && slots[next] === status) next++;
	const summary = [`<b>${copy.nowShort}</b> · ${copy.status[status]}`];
	if (next < slots.length) summary.push(`<b>${copy.nextShort}</b> · <b>${time(next)}</b> · ${copy.nextStatus[slots[next] as Status]}`);
	return formatMessage(group, language, summary.join('\n'), describe(day, language, start));
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

function describeChanges(before: Day, after: Day, language: Language): string {
	const copy = messages[language];
	const oldIntervals = outageIntervals(before);
	const newIntervals = outageIntervals(after);
	const overlaps = (first: Interval, second: Interval) =>
		first.status === second.status && first.start < second.end && second.start < first.end;
	const range = ({ start, end }: Interval) => `<b>${time(start)}–${time(end)}</b>`;
	const matched = new Set<Interval>();
	const lines: string[] = [];
	for (const old of oldIntervals) {
		const candidates = newIntervals.filter((interval) => overlaps(old, interval));
		const [candidate] = candidates;
		if (candidate && candidates.length === 1 && oldIntervals.filter((interval) => overlaps(candidate, interval)).length === 1) {
			matched.add(candidate);
			if (old.start !== candidate.start || old.end !== candidate.end) {
				lines.push(copy.moved(copy.outageLabels[old.status], range(old), range(candidate)));
			}
		} else {
			lines.push(copy.removed(copy.outageLabels[old.status], range(old)));
		}
	}
	for (const interval of newIntervals) {
		if (!matched.has(interval)) lines.push(copy.added(copy.outageLabels[interval.status], range(interval)));
	}
	const date = dateFormats[language].format(new Date(after.date)).replace(',', '');
	return `<b>${date.toUpperCase()}</b>\n${lines.join('\n')}`;
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
	const lines: string[] = [];
	const old = previous?.schedule.today;
	const source = result.source;
	const previousObservation = source && previous?.observed?.[source];
	const reported = result.schedule.today;
	// A source that still shows its previous schedule provides no evidence of a new revision.
	const schedule =
		previous && old?.date === reported.date && previousObservation?.date === reported.date && previousObservation.slots === reported.slots
			? previous.schedule
			: result.schedule;
	const day = schedule.today;
	if (preferences.updates && (old?.date !== day.date || old.slots !== day.slots)) {
		const sameDay = old?.date === day.date;
		lines.push(sameDay ? copy.updated : copy.initial, sameDay ? describeChanges(old, day, language) : describe(day, language));
	}

	const minute = clockMinute(now);
	const slot = Math.floor(minute / 30);
	const slots = day.slots;
	let next = slot + 1;
	while (next < slots.length && (slots[next] === slots[next - 1] || slots[next] === '3')) next++;
	const status = slots[next];
	const minutes = next * 30 - minute;
	let warning: string | undefined;
	if ((status === '0' || status === '1') && minutes <= preferences.minutes) {
		const clock = time(next);
		const key = day.date + ' ' + clock + ' · ';
		warning = previous?.warning;
		const enabled = status === '1' ? preferences.return : preferences.cutoff;
		const legacyLabels = { '0': '🔴 Corte previsto', '1': '🟢 Suministro previsto' };
		if (enabled && warning !== key + status && warning !== key + legacyLabels[status]) {
			lines.push(`<b>${copy.events[status]} · ${clock}</b>\n${copy.inMinutes(minutes)} · ${copy.reminderTime}`);
			warning = key + status;
		}
	}
	return {
		snapshot: { schedule, warning, ...(source && { observed: { ...previous?.observed, [source]: reported } }) } satisfies Snapshot,
		message: lines.length ? formatMessage(group, language, ...lines) : undefined,
	};
}
