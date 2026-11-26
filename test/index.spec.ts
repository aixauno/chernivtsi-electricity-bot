import { createExecutionContext, createScheduledController, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { currentSchedule, energyUaGroups, loadSchedule, officialChannel, scheduleMirror, source } from "../src/schedule";
import { webhookSecret } from "../src/telegram";

const bindings = env as unknown as Parameters<typeof worker.scheduled>[1];

function officialPage(date: string, slots: string, next = false) {
	const cells = { "0": "<o>в</o>", "1": "<u>з</u>", "3": "<s>мз</s>" } as const;
	const grid = Array.from(slots, (slot) => cells[slot as keyof typeof cells]).join("");
	const tomorrow = next ? '<a href="/shutdowns/?next">Завтра</a>' : "";
	return new Response(`<div id="gsv"><ul><p>${date.split("-").reverse().join(".")}</p><div id="inf10" data-id="10">${grid}</div></ul></div>${tomorrow}`);
}

afterEach(async () => {
	await reset();
});

describe("Chernivtsi electricity bot", () => {
	it("authenticates the collector and announces its newest fresh schedule", async () => {
		const now = new Date();
		const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(now);
		const context = createExecutionContext();
		const post = (token: string, fetchedAt: number, slots: string) => worker.fetch(new Request("https://example.com/schedule-collector", {
			method: "POST",
			headers: { Authorization: "Bearer " + token },
			body: JSON.stringify({ group: "10", fetchedAt, schedule: { today: { date, slots } } }),
		}), bindings, context);
		const sent = vi.fn();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
			if (url === energyUaGroups + "10") return new Response(null, { status: 503 });
			if (String(url).endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
			expect(String(url)).toMatch(/\/sendMessage$/);
			sent(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			expect((await post("wrong", now.getTime(), "1".repeat(48))).status).toBe(403);
			expect((await post("test-collector-token", now.getTime() - 181_000, "0".repeat(48))).status).toBe(400);
			expect((await post("test-collector-token", now.getTime(), "1".repeat(48))).status).toBe(204);
			await waitOnExecutionContext(context);
			expect((await post("test-collector-token", now.getTime() - 1000, "0".repeat(48))).status).toBe(204);
			await waitOnExecutionContext(context);
			expect(sent).toHaveBeenCalledTimes(1);
			expect(sent).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("No outages scheduled.") }));
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("uses an explicit official channel notice when the operator website is blocked", async () => {
		const now = new Date("2026-11-26T00:01:00+02:00");
		const notice = '<div data-post="oe_cv_ua/4205"><div class="tgme_widget_message_text js-message_text"><i><b>✨</b></i> На 26.11.2026<br/>Електропостачання без обмежень для всіх груп споживачів&#33;</div></div>';
		const provisional = '<div data-post="oe_cv_ua/4206"><div class="tgme_widget_message_text js-message_text">Орієнтовний графік на 26.11.2026</div></div>';
		let html = notice;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			url === officialChannel ? new Response(html) : new Response(null, { status: 403 }),
		);
		try {
			await expect(loadSchedule("10", now)).resolves.toEqual({
				today: { date: "2026-11-26", slots: "1".repeat(48) },
			});
			html += provisional;
			await expect(loadSchedule("10", now)).rejects.toThrow("HTTP 403");
			html += '<div data-post="oe_cv_ua/4218"><div class="tgme_widget_message_text">⚡ Орієнтовний графік заживлення на 26.11.2026<br>━━━━━━━━</div></div>';
			await expect(loadSchedule("10", now)).rejects.toMatchObject({ url: "https://t.me/oe_cv_ua/4218" });
			fetchMock.mockImplementation(async (url) => {
				if (url === officialChannel) return new Response(html);
				if (url === scheduleMirror) return new Response(
					"<p>Оновлено 26 листопада о 07:53</p><p>Джерело: сайт Чернівціобленерго</p>" +
					"<h3>Черга 10</h3><p>Сьогодні, 26 листопада без світла 5 год</p>" +
					"<p>Без світла: 08:00–10:30, 12:30–15:00 · можливо 10:30–11:00</p>" +
					"<p>Завтра</p><p>Графік ще не опублікований</p>",
				);
				return new Response(null, { status: 403 });
			});
			const schedule = await loadSchedule("10", now);
			expect(currentSchedule(schedule, now, "10", "en")).toBe(
				"<pre>CHERNIVTSI  /  GROUP 10\n─────────────────────\nNOW          Power expected\nNEXT         08:00 · Outage\n\n" +
				"THU 26 NOV   ·   LOCAL TIME\n− 08:00–10:30  Outage expected\n~ 10:30–11:00  Supply uncertain\n" +
				"− 12:30–15:00  Outage expected</pre>",
			);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("prefers a complete Energy-UA day over a collected schedule", async () => {
		const now = new Date("2026-11-26T08:57:00+02:00");
		const periods = "<div>00:00 – 11:00 <b>Є світло</b></div><div>11:00 – 14:00 <b>Немає світла</b></div>" +
			"<div>14:00 – 16:00 <b>Є світло</b></div><div>16:00 – 19:30 <b>Немає світла</b></div>" +
			"<div>19:30 – 24:00 <b>Є світло</b></div>";
		let html = "<div>Ваша черга <b>10</b></div><h2>Періоди відключень на сьогодні</h2>" +
			periods + "<footer>Графік на дату 26.11.2026</footer>";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			url === energyUaGroups + "10" ? new Response(html) : new Response(null, { status: 403 }),
		);
		try {
			const schedule = await loadSchedule("10", now, { today: { date: "2026-11-26", slots: "1".repeat(48) } });
			expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([energyUaGroups + "10"]);
			expect(currentSchedule(schedule, now, "10", "en")).toContain("NEXT         11:00 · Outage");
			expect(currentSchedule(schedule, now, "10", "en")).toContain("− 16:00–19:30  Outage expected");
			html = html.replace("19:30 – 24:00", "20:00 – 24:00");
			await expect(loadSchedule("10", now)).rejects.toThrow("HTTP 403");
			html = html.replace("20:00 – 24:00", "19:30 – 24:00").replace("26.11.2026", "25.11.2026");
			await expect(loadSchedule("10", now)).rejects.toThrow("HTTP 403");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("only accepts matching dates and complete rows from the official pages", async () => {
		const now = new Date("2026-11-26T00:01:00+02:00");
		const slots = "013".repeat(16);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (url === energyUaGroups + "10") return new Response(null, { status: 503 });
			expect([source, source + "?next"]).toContain(url);
			return officialPage("2026-11-26", slots, url === source);
		});
		try {
			await expect(loadSchedule("10", now)).resolves.toEqual({ today: { date: "2026-11-26", slots } });
			fetchMock.mockImplementation(async () => officialPage("2026-11-25", slots));
			await expect(loadSchedule("10", now)).rejects.toThrow("no verified schedule");
			fetchMock.mockImplementation(async () => officialPage("2026-11-26", slots.slice(1)));
			await expect(loadSchedule("10", now)).rejects.toThrow("no verified schedule");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("lets private chats subscribe and unsubscribe independently in their own language", async () => {
		const secret = await webhookSecret("test-token");
		const now = new Date();
		const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(now);
		const sends: { chat_id: string; text: string }[] = [];
		let slots = "0".repeat(48);
		const post = (update_id: number, id: number, text: string) => SELF.fetch("https://example.com/telegram", {
			method: "POST",
			headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
			body: JSON.stringify({ update_id, message: { chat: { id, type: "private" }, text } }),
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
			if (url === source) return officialPage(date, slots);
			if (String(url).endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
			sends.push(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			const cron = createScheduledController({ cron: "* * * * *" });
			expect((await post(60, 456, "/start")).status).toBe(204);
			expect(sends[0]).toMatchObject({ chat_id: "456", text: expect.stringContaining("Welcome!") });
			await worker.scheduled(cron, bindings);
			expect(sends.filter(({ chat_id, text }) => chat_id === "456" && text.startsWith("⚡"))).toEqual([]);

			expect((await post(61, 456, "/uk")).status).toBe(204);
			expect((await post(62, 456, "Отримувати сповіщення")).status).toBe(204);
			expect(sends.at(-1)).toMatchObject({ chat_id: "456", text: expect.stringContaining("Сповіщення увімкнено") });
			await worker.scheduled(cron, bindings);
			const notices = sends.filter(({ text }) => text.startsWith("⚡"));
			expect(notices).toHaveLength(2);
			expect(notices).toEqual(expect.arrayContaining([
				expect.objectContaining({ chat_id: "123", text: expect.stringContaining("Chernivtsi · Group 10") }),
				expect.objectContaining({ chat_id: "456", text: expect.stringContaining("Чернівці · Група 10") }),
			]));

			expect((await post(63, 123, "Stop alerts")).status).toBe(204);
			expect(sends.at(-1)).toMatchObject({ chat_id: "123", text: expect.stringContaining("Alerts are off") });
			slots = "1".repeat(48);
			sends.length = 0;
			await worker.scheduled(cron, bindings);
			expect(sends).toEqual([expect.objectContaining({
				chat_id: "456", text: expect.stringContaining("Графік оновлено"),
			})]);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("authenticates webhooks and answers a language command once without waiting for cron", async () => {
		expect((await SELF.fetch("https://example.com")).status).toBe(404);
		const post = (secret: string) => SELF.fetch("https://example.com/telegram", {
			method: "POST",
			headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
			body: JSON.stringify({ update_id: 42, message: { chat: { id: 123 }, text: "language" } }),
		});
		expect((await post("invalid")).status).toBe(403);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
			expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
			expect(JSON.parse(String(options?.body))).toMatchObject({
				chat_id: "123",
				text: expect.stringContaining("Choose your language"),
			});
			return Response.json({ ok: true });
		});
		try {
			const secret = await webhookSecret("test-token");
			expect((await post(secret)).status).toBe(204);
			expect((await post(secret)).status).toBe(204);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("retries a failed Telegram send and avoids duplicate notices after success", async () => {
		const now = new Date();
		const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(now);
		const telegram = vi.fn()
			.mockImplementationOnce(() => Response.json({ ok: false }, { status: 503 }))
			.mockImplementation(() => Response.json({ ok: true }));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
			if (url === source) return officialPage(date, "0".repeat(48));
			if (url === "https://api.telegram.org/bottest-token/getUpdates") {
				return Response.json({ ok: false, description: "Conflict: webhook is active" }, { status: 409 });
			}
			expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
			expect(options?.method).toBe("POST");
			return telegram(JSON.parse(String(options?.body)));
		});

		try {
			const cron = createScheduledController({ cron: "* * * * *" });
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow("Telegram sendMessage failed.");
			await worker.scheduled(cron, bindings);
			await worker.scheduled(cron, bindings);
			expect(telegram).toHaveBeenCalledTimes(2);
			expect(telegram).toHaveBeenLastCalledWith({
				chat_id: "123",
				parse_mode: "HTML",
				text: expect.stringContaining("⚡ <b>Chernivtsi · Group 10</b>"),
			});
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("welcomes the configured chat and remembers its language for later commands", async () => {
		const sends: unknown[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
			if (url === source) return new Response(null, { status: 503 });
			if (url === officialChannel) return new Response("");
			const body = JSON.parse(String(options?.body));
			if (url === "https://api.telegram.org/bottest-token/getUpdates") {
				const result = body.offset ? [] : [
					{ update_id: 1, message: { chat: { id: 456 }, text: "/estado" } },
					{ update_id: 2, message: { chat: { id: 123 }, text: "/start" } },
					{ update_id: 3, message: { chat: { id: 123 }, text: "/language" } },
					{ update_id: 4, message: { chat: { id: 123 }, text: "🇺🇦 Українська" } },
				];
				if (body.offset === 5) result.push({ update_id: 5, message: { chat: { id: 123 }, text: "/estado" } });
				return Response.json({ ok: true, result });
			}
			sends.push(body);
			return Response.json({ ok: true });
		});
		try {
			const cron = createScheduledController({ cron: "* * * * *" });
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow("HTTP 503");
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow("HTTP 503");
			expect(sends).toEqual([
				expect.objectContaining({ chat_id: "123", text: expect.stringContaining("<b>Welcome!</b>") }),
				expect.objectContaining({
					text: "<b>Choose your language</b>",
					reply_markup: expect.objectContaining({ keyboard: [[{ text: "Українська" }, { text: "English" }]] }),
				}),
				expect.objectContaining({ text: expect.stringContaining("Обрано українську мову") }),
				expect.objectContaining({ parse_mode: "HTML", text: expect.stringContaining("Актуальний графік наразі недоступний") }),
			]);
		} finally {
			fetchMock.mockRestore();
		}
	});
});
