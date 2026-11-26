export const source = "https://oblenergo.cv.ua/shutdowns/";

export type Day = { date: string; slots: string };
export type Schedule = { today: Day; tomorrow?: Day };

export const kyiv = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
	hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function scheduleDates(now: Date): [string, string] {
	const today = kyiv.format(now).slice(0, 10);
	const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
	return [today, tomorrow];
}

export type CollectedSchedule = { group: string; fetchedAt: number; schedule: Schedule };

export function checkedCollection(input: unknown, group: string, now: Date): CollectedSchedule | undefined {
	const collection = input as Partial<CollectedSchedule> | null;
	if (!collection || collection.group !== group || typeof collection.fetchedAt !== "number") return;
	const age = now.getTime() - collection.fetchedAt;
	if (!Number.isFinite(age) || age < -30_000 || age > 180_000) return;
	const [today, tomorrow] = scheduleDates(now);
	const schedule = collection.schedule;
	if (!validDay(schedule?.today, today) || (schedule?.tomorrow !== undefined && !validDay(schedule.tomorrow, tomorrow))) return;
	return {
		group,
		fetchedAt: collection.fetchedAt,
		schedule: {
			today: { date: today, slots: schedule.today.slots },
			tomorrow: schedule.tomorrow && { date: tomorrow, slots: schedule.tomorrow.slots },
		},
	};
}

function validDay(day: Day | undefined, date: string): day is Day {
	return day?.date === date && typeof day.slots === "string" && /^[013]{48}$/.test(day.slots);
}

export async function readWebsite(group: string, date: string, next: string): Promise<Schedule> {
	const html = await fetchPage(source);
	const today = readDay(html, group, date);
	if (!today) throw new Error("Oblenergo has no verified schedule for this group today.");
	const tomorrow = /href\s*=\s*["'](?:https:\/\/oblenergo\.cv\.ua)?\/shutdowns\/\?next["']/i.test(html)
		? await fetchPage(source + "?next").then((page) => readDay(page, group, next)).catch(() => undefined)
		: undefined;
	return { today, tomorrow };
}

export async function fetchPage(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "manual" });
	if (!response.ok) throw new Error("Schedule source returned HTTP " + response.status);
	return response.text();
}

function readDay(html: string, group: string, date: string): Day | undefined {
	const header = /<div\s+id=["']gsv["'][^>]*>\s*<ul[^>]*>\s*<p[^>]*>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/p>/i.exec(html);
	if (!header || header[1].split(".").reverse().join("-") !== date) return;
	const grid = html.slice(header.index + header[0].length);
	const rows = [...grid.matchAll(/<div\s+id=["']inf(\d+)["']\s+data-id=["'](\d+)["']\s*>([\s\S]*?)<\/div>/gi)]
		.filter((row) => row[1] === group && row[2] === group);
	if (rows.length !== 1) return;
	const cells = rows[0][3].replace(/\s/g, "").toLowerCase();
	if (!/^(?:<u>з<\/u>|<o>в<\/o>|<s>мз<\/s>){48}$/.test(cells)) return;
	const slots = cells.replaceAll("<u>з</u>", "1").replaceAll("<o>в</o>", "0").replaceAll("<s>мз</s>", "3");
	return { date, slots };
}

