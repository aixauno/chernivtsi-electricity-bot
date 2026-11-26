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
	readBackupPage?: () => Promise<string>,
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
			return { schedule: await readMirror(group, date, readBackupPage), source: 'mirror' };
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

function displayDate(date: string, language: Language): string {
	return dateFormats[language].format(new Date(date)).replace(',', '').toUpperCase();
}

function describeDay(day: Day, language: Language, currentSlot: number): string {
	const copy = messages[language];
	const scheduled = outageIntervals(day);
	const intervals = scheduled.filter(({ end }) => end > currentSlot);
	return (
		intervals
			.map(
				({ start, end, status }, index) =>
					`${index === intervals.length - 1 ? '╰' : '╌'} <b>${time(start)}–${time(end)}</b>${status === '3' ? ` · <i>${copy.outageLabels[status]}</i>` : ''}`,
			)
			.join('\n') || (scheduled.length ? copy.noRemainingOutages : copy.noOutages)
	);
}

function clockMinute(now: Date): number {
	const [, clock] = kyiv.format(now).split(' ');
	const [hours, minutes] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

type CardDetails = { checkedAt?: number; previous?: Schedule; stale?: Schedule; notices?: string[]; showFullDay?: boolean };

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
	const start = Math.floor(minute / 30);
	const summary = [`<b>${copy.nowShort}</b> · ${result && today ? copy.status[today.slots[start] as Status] : copy.unknownStatus}`];
	if (result && today) {
		const slots = today.slots;
		let next = start + 1;
		while (next < slots.length && slots[next] === slots[start]) next++;
		if (next < slots.length) {
			const countdown =
				slots[next] === '0' && !details.notices?.length && next * 30 - minute <= defaultAlerts.minutes
					? ` · <i>${copy.inMinutes(next * 30 - minute)}</i>`
					: '';
			summary.push(`<b>${copy.nextShort}</b> · <b>${time(next)}</b> · ${copy.nextStatus[slots[next] as Status]}${countdown}`);
		}
	} else {
		summary.push(`<b>${copy.nextShort}</b> · ${copy.unknownTransition}`);
	}
	const stale = result ? '' : `<i>${copy.previousSchedule}</i>\n`;
	const todayHeading = `<b>${copy.todayButton} · ${displayDate(date, language)}</b> · <i>${copy.localTime}</i>`;
	const todayText = today ? stale + describeDay(today, language, result && !details.showFullDay ? start : 0) : copy.scheduleUnavailable;
	const notes = details.notices ? [...details.notices] : [];
	if (!result) notes.push(`✦ <b>${copy.unavailable}</b>`);
	else if (!details.notices && today && details.previous?.today.date === date) {
		const before = details.previous.today;
		if (before.slots !== today.slots) notes.push(`✦ ${copy.updated}\n${describeChanges(before, today, language)}`);
		else notes.push(`<i>${copy.noChanges}</i>`);
	}
	if (details.checkedAt !== undefined) {
		const [updatedDate, updatedTime] = kyiv.format(new Date(details.checkedAt)).split(' ');
		const priorDate = updatedDate === date ? '' : ` <b>${displayDate(updatedDate, language)}</b> ·`;
		notes.push(`<i>${result ? copy.updatedAt : copy.lastUpdate}</i>${priorDate} <b>${updatedTime}</b>`);
	}
	const sections = [summary.join('\n'), `${todayHeading}\n${todayText}`];
	if (notes.length) sections.push(notes.join('\n'));
	return formatMessage(group, language, ...sections);
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
	const range = ({ start, end }: Interval) => `<code>${time(start)}–${time(end)}</code>`;
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
	const visibleChanges = 5;
	if (lines.length > visibleChanges)
		lines.splice(visibleChanges, lines.length, `<i>${copy.moreChanges(lines.length - visibleChanges)}</i>`);
	return lines.join('\n');
}

export function notification(
	result: VerifiedSchedule,
	now: Date,
	group: string,
	language: Language,
	previous?: Snapshot,
	preferences: AlertPreferences = defaultAlerts,
	checkedAt = now.getTime(),
) {
	const copy = messages[language];
	const lines: string[] = [];
	const old = previous?.schedule.today;
	const source = result.source;
	const previousObservation = source && previous?.observed?.[source];
	const reported = result.schedule.today;
	// A source that still shows its previous schedule for today provides no evidence of a revision for today.
	const day =
		old?.date === reported.date &&
		old.slots !== reported.slots &&
		previousObservation?.date === reported.date &&
		previousObservation.slots === reported.slots
			? old
			: reported;
	const schedule = { today: day };
	if (preferences.updates) {
		if (old?.date !== day.date) lines.push(`✦ ${copy.initial}`);
		else if (old.slots !== day.slots) lines.push(`✦ ${copy.updated}\n${describeChanges(old, day, language)}`);
	}

	const minute = clockMinute(now);
	const slot = Math.floor(minute / 30);
	const slots = day.slots;
	let next = slot + 1;
	while (next < slots.length && (slots[next] === slots[next - 1] || slots[next] === '3')) next++;
	const status = slots[next];
	const minutes = next * 30 - minute;
	const warnings = old?.date === day.date ? [...(previous?.warnings ?? (previous?.warning ? [previous.warning] : []))] : [];
	if ((status === '0' || status === '1') && minutes <= preferences.minutes) {
		const clock = time(next);
		const key = day.date + ' ' + clock + ' · ';
		const enabled = status === '1' ? preferences.return : preferences.cutoff;
		const legacyLabels = { '0': '🔴 Corte previsto', '1': '🟢 Suministro previsto' };
		if (enabled && !warnings.includes(key + status) && !warnings.includes(key + legacyLabels[status])) {
			lines.push(`✦ <b>${copy.events[status]} · ${clock}</b> · <i>${copy.inMinutes(minutes)}</i>`);
			warnings.push(key + status);
		}
	}
	return {
		snapshot: {
			schedule,
			...(warnings.length && { warnings }),
			...(source && { observed: { ...previous?.observed, [source]: reported } }),
		} satisfies Snapshot,
		message: lines.length
			? currentSchedule({ ...result, schedule }, now, group, language, { checkedAt, notices: lines, showFullDay: true })
			: undefined,
	};
}
