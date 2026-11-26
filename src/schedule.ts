import { messages, type Language } from "./messages";

import { fetchPage, kyiv, readWebsite, scheduleDates, type Day, type Schedule } from "./official";

export { source, type Schedule } from "./official";
export const officialChannel = "https://t.me/s/oe_cv_ua";
export const scheduleMirror = "https://miyinvertor.com.ua/grafik/chernivtsi";
export const energyUaGroups = "https://chernivtsi.energy-ua.info/grupa/";

export type Snapshot = { schedule: Schedule; status: string; warning?: string };

export class PublishedSchedule extends Error {
	constructor(readonly url: string, cause: unknown) {
		super("The official channel published a schedule without verifiable time slots.", { cause });
	}
}

export async function loadSchedule(group: string, now: Date, collected?: Schedule): Promise<Schedule> {
	const [date, next] = scheduleDates(now);
	const energyUa = await fetchPage(energyUaGroups + group)
		.then((html) => readEnergyUa(html, group, date)).catch(() => undefined);
	if (energyUa) return { today: energyUa };
	if (collected) return collected;
	try {
		return await readWebsite(group, date, next);
	} catch (error) {
		const channel = await fetchPage(officialChannel).catch(() => "");
		const today = readAnnouncement(channel, date);
		const mirror = today && !today.day
			? await fetchPage(scheduleMirror).then((html) => readMirror(html, group, date)).catch(() => undefined)
			: undefined;
		const day = today?.day ?? mirror;
		if (day) return { today: day, tomorrow: readAnnouncement(channel, next)?.day };
		if (today) throw new PublishedSchedule(today.url, error);
		throw error;
	}
}

function pageText(html: string): string {
	return html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>|&nbsp;|&#160;/gi, " ").replace(/&ndash;|&#8211;/gi, "–").replace(/\s+/g, " ");
}

function readEnergyUa(html: string, group: string, date: string): Day | undefined {
	const text = pageText(html);
	const groupId = /Ваша черга\s+(\d+)\b/u.exec(text)?.[1];
	const section = /Періоди відключень на сьогодні\s+([\s\S]*?)Графік на дату\s+(\d{2}\.\d{2}\.\d{4})/u.exec(text);
	if (groupId !== group || section?.[2].split(".").reverse().join("-") !== date) return;
	let slots = "";
	for (const [, hourStart, minuteStart, hourEnd, minuteEnd, label] of section[1].matchAll(
		/(\d{2}):(00|30)\s*[–-]\s*(\d{2}):(00|30)\s+(Є світло|Немає світла)(?=\s|$)/gu,
	)) {
		const start = Number(hourStart) * 2 + Number(minuteStart) / 30;
		const end = Number(hourEnd) * 2 + Number(minuteEnd) / 30;
		if (start !== slots.length || end <= start || end > 48) return;
		slots += (label === "Є світло" ? "1" : "0").repeat(end - start);
	}
	if (slots.length === 48) return { date, slots };
}

function readMirror(html: string, group: string, date: string): Day | undefined {
	const text = pageText(html);
	const dayLabel = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" })
		.format(new Date(date));
	if (!text.includes("Оновлено " + dayLabel + " о ") || !/Джерело:\s*сайт Чернівціобленерго/u.test(text)) return;
	const rows = [...text.matchAll(/Черга (\d+)\s+([\s\S]*?)(?=Черга \d+\s|$)/gu)];
	const row = rows.find(([, id, body]) => id === group && body.includes("Сьогодні, " + dayLabel + " "))?.[2];
	const today = row?.split(/\s+Завтра(?:\s|$)/u)[0];
	const intervals = /Без світла:\s*(.*?)\s*$/u.exec(today ?? "")?.[1];
	if (!intervals) return;
	const [outages, uncertain, ...extra] = intervals.split(/\s*·\s*можливо\s+/u);
	if (extra.length) return;
	const slots = Array<string>(48).fill("1");
	for (const [list, status] of [[outages, "0"], [uncertain, "3"]]) {
		if (list === undefined) continue;
		for (const interval of list.split(/\s*,\s*/)) {
			const range = /^(\d{2}):(00|30)\s*–\s*(\d{2}):(00|30)$/.exec(interval);
			if (!range) return;
			const start = Number(range[1]) * 2 + Number(range[2]) / 30;
			const end = Number(range[3]) * 2 + Number(range[4]) / 30;
			if (start >= end || end > 48 || slots.slice(start, end).some((slot) => slot !== "1")) return;
			slots.fill(status, start, end);
		}
	}
	return { date, slots: slots.join("") };
}

function readAnnouncement(html: string, date: string): { url: string; day?: Day } | undefined {
	const dated = date.split("-").reverse().join(".");
	const posts = [...html.matchAll(/data-post="oe_cv_ua\/(\d+)"[^>]*>([\s\S]*?)(?=data-post="|$)/gi)];
	for (const [, id, body] of posts.sort((a, b) => Number(b[1]) - Number(a[1]))) {
		const markup = /<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body)?.[1];
		const firstLines = markup?.split(/<br\s*\/?>/i).slice(0, 2)
			.map((line) => line.replace(/<[^>]*>/g, "").replace(/&#33;|&#x21;/gi, "!").replace(/&nbsp;/gi, " ").trim());
		if (!firstLines?.[0].includes(dated)) continue;
		const explicit = firstLines[0].replace(/^✨\s*/, "").toLowerCase() === "на " + dated
			&& /^електропостачання без обмежень для всіх груп споживачів[.!]?$/iu.test(firstLines[1] ?? "");
		const published = /^⚡\uFE0F?\s*орієнтовний графік заживлення\s/iu.test(firstLines[0]);
		if (explicit || published) {
			return { url: "https://t.me/oe_cv_ua/" + id, day: explicit ? { date, slots: "1".repeat(48) } : undefined };
		}
		return undefined;
	}
}

type Status = keyof typeof messages.en.status;

const dateFormats = {
	en: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }),
	uk: new Intl.DateTimeFormat("uk-UA", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }),
};

function time(slot: number): string {
	const hour = String(Math.floor(slot / 2)).padStart(2, "0");
	return hour + (slot % 2 === 0 ? ":00" : ":30");
}

function describe(day: Day, language: Language): string {
	const copy = messages[language];
	const intervals: string[] = [];
	for (let start = 0; start < day.slots.length;) {
		const status = day.slots[start] as Status;
		let end = start + 1;
		while (day.slots[end] === status) end++;
		if (status !== "1") {
			const marker = status === "0" ? "−" : "~";
			intervals.push(`${marker} ${time(start)}–${time(end)}  ${copy.status[status]}`);
		}
		start = end;
	}
	const date = dateFormats[language].format(new Date(day.date)).replace(",", "");
	return `${date.toUpperCase()}   ·   ${copy.localTime.toUpperCase()}\n${intervals.join("\n") || copy.noOutages}`;
}

function currentPeriod(schedule: Schedule, now: Date) {
	const [, clock] = kyiv.format(now).split(" ");
	const [hours, minutes] = clock.split(":").map(Number);
	const minute = hours * 60 + minutes;
	const slot = Math.floor(minute / 30);
	const slots = schedule.today.slots + (schedule.tomorrow?.slots ?? "");
	const status = slots[slot] as Status;
	let end = slot + 1;
	while (slots[end] === status) end++;
	const date = end < 48 ? schedule.today.date : schedule.tomorrow?.date;
	const next = end < slots.length && date
		? { date, time: time(end % 48), status: slots[end] as Status, minutes: end * 30 - minute }
		: undefined;
	return { status, next };
}

export function currentSchedule(schedule: Schedule, now: Date, group: string, language: Language): string {
	const copy = messages[language];
	const { status, next } = currentPeriod(schedule, now);
	const title = copy.title(group).replace(" · ", "  /  ").toUpperCase();
	const lines = [title, "─────────────────────", copy.nowShort.padEnd(13) + copy.status[status]];
	if (next) {
		const when = next.date === schedule.today.date ? next.time : next.date + " · " + next.time;
		lines.push(copy.nextShort.padEnd(13) + `${when} · ${copy.nextStatus[next.status]}`);
	}
	lines.push("", describe(schedule.today, language));
	if (schedule.tomorrow) lines.push("", describe(schedule.tomorrow, language));
	return lines.join("\n");
}

export function notification(schedule: Schedule, now: Date, group: string, language: Language, previous?: Snapshot) {
	const copy = messages[language];
	const { status, next } = currentPeriod(schedule, now);
	const warningTime = next && next.minutes <= 15 ? next.date + " " + next.time + " · " : undefined;
	const warning = warningTime && next ? warningTime + next.status : undefined;
	const oldDays = [previous?.schedule.today, previous?.schedule.tomorrow];
	const changed = [schedule.today, schedule.tomorrow].filter((day): day is Day =>
		day !== undefined && oldDays.find((old) => old?.date === day.date)?.slots !== day.slots,
	);
	const lines: string[] = [];
	if (!previous) lines.push(copy.initial);
	else if (changed.length) lines.push(copy.updated);
	if (!previous || previous.status !== status) lines.push("<b>" + copy.now + "</b>\n" + copy.status[status]);
	const legacyLabels = { "0": "🔴 Corte previsto", "1": "🟢 Suministro previsto", "3": "🟡 Suministro incierto" };
	if (next && warningTime && previous?.warning !== warning && previous?.warning !== warningTime + legacyLabels[next.status]) {
		lines.push(`${copy.next} · <b>${next.time}</b>\n${copy.status[next.status]}`);
	}
	for (const day of changed) lines.push(describe(day, language));

	return {
		snapshot: { schedule, status, warning } satisfies Snapshot,
		message: lines.length ? [`⚡ <b>${copy.title(group)}</b>`, ...lines, ...(changed.length ? [] : [`<i>${copy.localTime}</i>`])].join("\n\n") : undefined,
	};
}

