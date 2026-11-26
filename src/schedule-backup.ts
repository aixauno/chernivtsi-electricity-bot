import { pageText, type Day, type Schedule } from './energy-ua';

const mirrorUrl = 'https://miyinvertor.com.ua/grafik/chernivtsi';

export async function readMirror(group: string, date: string): Promise<Schedule> {
	const response = await fetch(mirrorUrl, {
		signal: AbortSignal.timeout(8_000),
		cache: 'no-store',
		redirect: 'manual',
	});
	if (!response.ok) throw new Error('Backup returned HTTP ' + response.status);
	const today = parseMirror(await response.text(), group, date);
	if (!today) throw new Error('Backup has no verified schedule for this group today.');
	return { today };
}

function parseMirror(html: string, group: string, date: string): Day | undefined {
	const text = pageText(html);
	const dayLabel = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(date));
	if (!text.includes('Оновлено ' + dayLabel + ' о ') || !/Джерело:\s*сайт Чернівціобленерго/u.test(text)) return;
	const rows = [...text.matchAll(/Черга (\d+)\s+([\s\S]*?)(?=Черга \d+\s|$)/gu)];
	const row = rows.find(([, id, body]) => id === group && body.includes('Сьогодні, ' + dayLabel + ' '))?.[2];
	const today = row?.split(/\s+Завтра(?:\s|$)/u)[0];
	const intervals = /Без світла:\s*(.*?)\s*$/u.exec(today ?? '')?.[1];
	if (!intervals) return;
	const [outages, uncertain, ...extra] = intervals.split(/\s*·\s*можливо\s+/u);
	if (extra.length) return;
	const slots = Array<string>(48).fill('1');
	for (const [list, status] of [
		[outages, '0'],
		[uncertain, '3'],
	]) {
		if (list === undefined) continue;
		for (const interval of list.split(/\s*,\s*/)) {
			const range = /^(\d{2}):(00|30)\s*–\s*(\d{2}):(00|30)$/.exec(interval);
			if (!range) return;
			const start = Number(range[1]) * 2 + Number(range[2]) / 30;
			const end = Number(range[3]) * 2 + Number(range[4]) / 30;
			if (start >= end || end > 48 || slots.slice(start, end).some((slot) => slot !== '1')) return;
			slots.fill(status, start, end);
		}
	}
	return { date, slots: slots.join('') };
}
