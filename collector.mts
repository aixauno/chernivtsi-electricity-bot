import { readWebsite, scheduleDates, type CollectedSchedule } from "./src/official.ts";

const { SCHEDULE_COLLECTOR_TOKEN: token, SCHEDULE_COLLECTOR_URL: url, OUTAGE_GROUP: group = "10" } = process.env;
if (!token || !url || new URL(url).protocol !== "https:" || !/^(?:[1-9]|1[0-2])$/.test(group)) {
	throw new Error("Configure SCHEDULE_COLLECTOR_TOKEN, an HTTPS SCHEDULE_COLLECTOR_URL, and a valid OUTAGE_GROUP.");
}

const interval = 60_000;
while (true) {
	const now = new Date();
	try {
		const [today, tomorrow] = scheduleDates(now);
		const schedule = await readWebsite(group, today, tomorrow);
		const collection: CollectedSchedule = { group, fetchedAt: now.getTime(), schedule };
		const response = await fetch(url, {
			method: "POST",
			headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
			body: JSON.stringify(collection),
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("Worker returned HTTP " + response.status);
		console.log(now.toISOString(), "Official schedule verified and delivered.");
	} catch (error) {
		console.error(now.toISOString(), error instanceof Error ? error.message : "Schedule collection failed.");
	}
	await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, interval - (Date.now() - now.getTime()))));
}
