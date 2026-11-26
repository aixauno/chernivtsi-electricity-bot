export const energyUaGroups = 'https://chernivtsi.energy-ua.info/grupa/';

export type Day = { date: string; slots: string };
export type Schedule = { today: Day };

export const kyiv = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Kyiv',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

export function scheduleDate(now: Date): string {
	return kyiv.format(now).slice(0, 10);
}

export async function readEnergyUa(group: string, date: string): Promise<Schedule> {
	return parseEnergyUa(await fetchSchedulePage(energyUaGroups + group, 'Energy UA'), group, date);
}

export async function fetchSchedulePage(url: string, source: string): Promise<string> {
	const signal = AbortSignal.timeout(8_000);
	let response: Response;
	try {
		response = await fetch(url, { signal, cache: 'no-store', redirect: 'manual' });
	} catch (error) {
		throw new Error(source + (signal.aborted ? ' request timed out.' : ' network request failed.'), { cause: error });
	}
	if (!response.ok) throw new Error(source + ' returned HTTP ' + response.status);
	try {
		return await response.text();
	} catch (error) {
		throw new Error(source + (signal.aborted ? ' request timed out.' : ' response could not be read.'), { cause: error });
	}
}

export function parseEnergyUa(html: string, group: string, date: string): Schedule {
	const text = pageText(html);
	const groupId = /Ваша черга\s+(\d+)\b/u.exec(text)?.[1];
	if (groupId === group) {
		const payload = /<script\b[^>]*\s+id\s*=\s*["']schedulePayload["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(
			html.replace(/<!--[\s\S]*?-->/g, ''),
		);
		if (payload) {
			const schedule = readPayload(payload[1], date);
			if (schedule) return schedule;
		} else {
			const today = readRenderedDay(text, date);
			if (today) return { today };
		}
	}
	throw new Error('Energy UA has no verified schedule for this group today.');
}

export function pageText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]*>|&nbsp;|&#160;/gi, ' ')
		.replace(/&ndash;|&#8211;/gi, '–')
		.replace(/\s+/g, ' ');
}

function readPayload(json: string, date: string): Schedule | undefined {
	let payload: { today?: unknown; dates?: { today?: unknown } } | null;
	try {
		payload = JSON.parse(json);
	} catch {
		return;
	}
	const today = readPayloadDay(payload?.today, payload?.dates?.today, date);
	if (today) return { today };
}

function readPayloadDay(periods: unknown, publishedDate: unknown, date: string): Day | undefined {
	if (publishedDate !== date.split('-').reverse().join('.') || !Array.isArray(periods) || !periods.length) return;

	const slots = Array<string>(48).fill('1');
	for (const period of periods) {
		const { from, to, status } = period ?? {};
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < 0 ||
			to > 1440 ||
			from >= to ||
			from % 30 !== 0 ||
			to % 30 !== 0 ||
			(status !== 'red' && status !== 'yellow' && status !== 'green')
		)
			return;

		// Energy UA marks gaps as powered and gives confirmed outages priority over possible ones.
		if (status === 'red') slots.fill('0', from / 30, to / 30);
		if (status === 'yellow') {
			for (let slot = from / 30; slot < to / 30; slot++) {
				if (slots[slot] === '1') slots[slot] = '3';
			}
		}
	}
	return { date, slots: slots.join('') };
}

function readRenderedDay(text: string, date: string): Day | undefined {
	const section = /Періоди відключень на сьогодні\s+([\s\S]*?)Графік на дату\s+(\d{2}\.\d{2}\.\d{4})/u.exec(text);
	if (section?.[2].split('.').reverse().join('-') !== date) return;
	let slots = '';
	for (const [, hourStart, minuteStart, hourEnd, minuteEnd, label] of section[1].matchAll(
		/(\d{2}):(00|30)\s*[–-]\s*(\d{2}):(00|30)\s+(Є світло|Немає світла)(?=\s|$)/gu,
	)) {
		const start = Number(hourStart) * 2 + Number(minuteStart) / 30;
		const end = Number(hourEnd) * 2 + Number(minuteEnd) / 30;
		if (start !== slots.length || end <= start || end > 48) return;
		slots += (label === 'Є світло' ? '1' : '0').repeat(end - start);
	}
	if (slots.length === 48) return { date, slots };
}
