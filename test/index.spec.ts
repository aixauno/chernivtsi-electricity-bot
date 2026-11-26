import { createScheduledController, env, reset, runInDurableObject, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { energyUaGroups, parseEnergyUa } from '../src/energy-ua';
import { readBrowserSchedule } from '../src/energy-ua-browser';
import { currentSchedule, loadSchedule, notification } from '../src/schedule';
import { defaultAlerts } from '../src/messages';
import { webhookSecret } from '../src/telegram';

const bindings = env as unknown as Parameters<typeof worker.scheduled>[1];

const source = energyUaGroups + '10';
const backup = 'https://miyinvertor.com.ua/grafik/chernivtsi';

function energyPage(date: string, periods: string) {
	const day = date.split('-').reverse().join('.');
	return new Response(
		`<div>Ваша черга <b>10</b></div><h2>Періоди відключень на сьогодні</h2>${periods}<footer>Графік на дату ${day}</footer>`,
	);
}

afterEach(async () => {
	vi.useRealTimers();
	await reset();
});

describe('Chernivtsi electricity bot', () => {
	it('rejects uploads to the former collector endpoint', async () => {
		const response = await SELF.fetch('https://example.com/schedule-collector', { method: 'POST' });
		expect(response.status).toBe(404);
	});

	it('accepts only matching, complete Energy UA data and ignores the Tomorrow tab label', async () => {
		const now = new Date('2026-11-26T08:57:00+02:00');
		let date = '2026-11-26';
		let periods =
			'<div>Завтра Пт. 27.11.2026</div><div>00:00 – 11:00 <b>Є світло</b></div>' +
			'<div>11:00 – 14:00 <b>Немає світла</b></div><div>14:00 – 24:00 <b>Є світло</b></div>';
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async (url) => (url === source ? energyPage(date, periods) : new Response(null, { status: 503 })));
		try {
			const schedule = await loadSchedule('10', now);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledWith(source, expect.objectContaining({ cache: 'no-store' }));
			expect(Object.keys(schedule.schedule)).toEqual(['today']);
			expect(currentSchedule(schedule, now, '10', 'en')).toContain('<b>NEXT</b> · <b>11:00</b> · Outage');
			date = '2026-11-25';
			await expect(loadSchedule('10', now)).rejects.toThrow('no verified schedule');
			date = '2026-11-26';
			periods = periods.replace('14:00 – 24:00', '14:30 – 24:00');
			await expect(loadSchedule('10', now)).rejects.toThrow('no verified schedule');
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('reads Energy UA periods from the initial HTML and validates the group and day', () => {
		const date = '2026-11-26';
		const today = [
			{ from: 780, to: 960, status: 'red' },
			{ from: 1260, to: 1380, status: 'red' },
			{ from: 930, to: 990, status: 'yellow' },
		];
		const page = (periods: typeof today, tomorrow?: typeof today) =>
			'<div>Ваша черга <b>10</b></div><script id="schedulePayload" type="application/json">' +
			JSON.stringify({ dates: { today: '26.11.2026', tomorrow: '27.11.2026' }, today: periods, tomorrow }) +
			'</script>';
		const html = page(today);
		expect(parseEnergyUa(html, '10', date)).toEqual({
			today: { date, slots: '1'.repeat(26) + '0'.repeat(6) + '3' + '1'.repeat(9) + '0'.repeat(4) + '1'.repeat(2) },
		});
		expect(() => parseEnergyUa(html, '11', date)).toThrow('no verified schedule');
		expect(() => parseEnergyUa(html, '10', '2026-11-27')).toThrow('no verified schedule');
		expect(() => parseEnergyUa(page([]), '10', date)).toThrow('no verified schedule');
		expect(() => parseEnergyUa(page([{ from: 785, to: 960, status: 'red' }]), '10', date)).toThrow('no verified schedule');
		const tomorrow = [{ from: 0, to: 120, status: 'red' }];
		const fromPayload = parseEnergyUa(page(today, tomorrow), '10', date);
		expect(fromPayload).toEqual(parseEnergyUa(html, '10', date));
		const card = currentSchedule({ schedule: fromPayload }, new Date('2026-11-26T23:45:00+02:00'), '10', 'en');
		expect(card).toContain('<b>Chernivtsi · Group 10</b>');
		expect(card).toContain('<b>Today · THU 26 NOV</b> · <i>Local time</i>');
		expect(card).not.toMatch(/NEXT|Tomorrow|00:00–02:00/);
	});

	it('queries the live mirror between browser reads and after the daily browser budget is reached', async () => {
		const stub = bindings.MONITOR.getByName('test-browser-budget');
		const date = '2026-11-26';
		const html = await energyPage(date, '<div>00:00 – 24:00 <b>Є світло</b></div>').text();
		let browserTime = '1000';
		const browser = {
			quickAction: vi.fn(async () => Response.json({ result: html }, { headers: { 'x-browser-ms-used': browserTime } })),
		};
		let outageTime = '13:00–16:00';
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === source) return new Response(null, { status: 403 });
			expect(url).toBe(backup);
			return new Response(
				'<p>Оновлено 26 листопада о 13:22 Джерело: сайт Чернівціобленерго</p>' +
					`<h3>Черга 10</h3><p>Сьогодні, 26 листопада без світла 3 год</p><p>Без світла: ${outageTime}</p>`,
			);
		});
		try {
			await runInDurableObject(stub, async (_instance, state) => {
				const load = (time: string) => {
					const now = new Date(time);
					return loadSchedule('10', now, (day) => readBrowserSchedule(browser, state.storage, '10', day, now));
				};
				expect((await load('2026-11-26T12:06:00Z')).source).toBe('energy-ua');
				expect((await load('2026-11-26T12:07:00Z')).schedule.today.slots.slice(26, 32)).toBe('000000');
				expect(browser.quickAction).toHaveBeenCalledTimes(1);
				browserTime = '470000';
				expect((await load('2026-11-26T12:11:00Z')).source).toBe('energy-ua');
				outageTime = '14:00–16:00';
				expect((await load('2026-11-26T12:16:00Z')).schedule.today.slots.slice(26, 32)).toBe('110000');
				expect(browser.quickAction).toHaveBeenCalledTimes(2);
				const nextDay = new Date('2026-11-27T00:00:00Z');
				await expect(readBrowserSchedule(browser, state.storage, '10', '2026-11-27', nextDay)).rejects.toThrow('no verified schedule');
				expect(browser.quickAction).toHaveBeenCalledTimes(3);
			});
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('does not send a reversion when the backup still has its already observed schedule', () => {
		const now = new Date('2026-11-26T10:00:00+02:00');
		const original = { today: { date: '2026-11-26', slots: '1'.repeat(48) } };
		const revised = { today: { date: '2026-11-26', slots: '1'.repeat(26) + '0'.repeat(6) + '1'.repeat(16) } };
		const first = notification({ schedule: original, source: 'mirror' }, now, '10', 'en');
		const update = notification({ schedule: revised, source: 'energy-ua' }, now, '10', 'en', first.snapshot);
		expect(update.message).toContain('13:00–16:00');
		const stale = { schedule: original, source: 'mirror' } as const;
		expect(notification(stale, now, '10', 'en', update.snapshot).message).toBeUndefined();
		expect(notification({ schedule: revised, source: 'mirror' }, now, '10', 'en', update.snapshot).message).toBeUndefined();

		const reminderTime = new Date('2026-11-26T12:45:00+02:00');
		const reminder = notification(stale, reminderTime, '10', 'en', update.snapshot);
		expect(reminder.message).toContain('✦ <b>Outage starts · 13:00</b> · <i>in 15 min</i>');
		expect(notification(stale, reminderTime, '10', 'en', reminder.snapshot).message).toBeUndefined();
	});

	it('ignores changes for tomorrow and retries a change for today if Telegram rejects the send', async () => {
		const now = new Date('2026-11-26T01:00:00+02:00');
		const cron = createScheduledController({ cron: '* * * * *' });
		vi.useFakeTimers({ toFake: ['Date'] });
		const atMinute = (minute: number) => vi.setSystemTime(now.getTime() + minute * 60_000);
		atMinute(0);
		let todayStart = 13;
		let tomorrowStart = 14;
		let useBackup = false;
		const send = vi.fn<(_: { chat_id: string; text: string }) => Response>(() => Response.json({ ok: true }));
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) {
				if (useBackup) return new Response(null, { status: 503 });
				return new Response(
					'<div>Ваша черга <b>10</b></div><script id="schedulePayload">' +
						JSON.stringify({
							dates: { today: '26.11.2026', tomorrow: '27.11.2026' },
							today: [{ from: todayStart * 60, to: 960, status: 'red' }],
							tomorrow: [{ from: tomorrowStart * 60, to: 960, status: 'red' }],
						}) +
						'</script>',
				);
			}
			if (url === backup) {
				return new Response(
					'<p>Оновлено 26 листопада о 00:30 Джерело: сайт Чернівціобленерго</p>' +
						'<h3>Черга 10</h3><p>Сьогодні, 26 листопада без світла 1 год</p><p>Без світла: 15:00–16:00</p>',
				);
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			if (String(url).endsWith('/sendMessage')) return send(JSON.parse(String(options?.body)));
			return new Response(null, { status: 503 });
		});
		try {
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(1);
			expect(send.mock.lastCall?.[0].text).not.toContain('Tomorrow');
			tomorrowStart = 15;
			atMinute(3);
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(1);
			send.mockClear();

			todayStart = 14;
			atMinute(6);
			send.mockImplementationOnce(() => Response.json({ ok: false }, { status: 503 }));
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow('Telegram sendMessage failed. HTTP 503.');
			atMinute(7);
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.lastCall?.[0]).toEqual(send.mock.calls[0][0]);
			expect(send.mock.lastCall?.[0]).toMatchObject({
				chat_id: '123',
				text: expect.stringContaining('<code>13:00–14:00</code> · Outage expected → Power expected'),
			});
			atMinute(8);
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(2);

			await runInDurableObject(bindings.MONITOR.getByName('chernivtsi'), async (_monitor, state) => {
				await state.storage.put('energy-ua:browser-usage', {
					utcDay: now.toISOString().slice(0, 10),
					usedMs: 0,
					lastAttempt: now.getTime() + 9 * 60_000,
				});
			});
			useBackup = true;
			atMinute(9);
			await worker.scheduled(cron, bindings);
			expect(send.mock.lastCall?.[0].text).toContain('<code>14:00–15:00</code> · Outage expected → Power expected');

			useBackup = false;
			atMinute(12);
			await worker.scheduled(cron, bindings);
			expect(send.mock.lastCall?.[0].text).toContain('<code>14:00–15:00</code> · Power expected → Outage expected');
			atMinute(13);
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(4);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('sends a schedule update when the 23:00 slot changes from powered to uncertain', async () => {
		const cron = createScheduledController({ cron: '* * * * *' });
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-26T22:57:00+02:00'));
		const send = vi.fn();
		let uncertain = false;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) {
				const today = [{ from: 960, to: 1020, status: 'red' }];
				if (uncertain) today.push({ from: 1380, to: 1410, status: 'yellow' });
				return new Response(
					'<div>Ваша черга <b>10</b></div><script id="schedulePayload">' +
						JSON.stringify({ dates: { today: '26.11.2026' }, today }) +
						'</script>',
				);
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			expect(String(url)).toMatch(/\/sendMessage$/);
			send(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			await worker.scheduled(cron, bindings);
			uncertain = true;
			vi.setSystemTime(new Date('2026-11-26T23:00:00+02:00'));
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.lastCall?.[0]).toMatchObject({ chat_id: '123', parse_mode: 'HTML' });
			const message = send.mock.lastCall?.[0].text;
			expect(message).toMatch(/^<b>Chernivtsi · Group 10<\/b>\n────────────────────\n\n/u);
			expect(message).toContain('✦ <b>Schedule updated</b>\n<code>23:00–23:30</code> · Power expected → Supply uncertain');
			expect(message).not.toContain('16:00–17:00');
			await worker.scheduled(cron, bindings);
			expect(send).toHaveBeenCalledTimes(2);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('backs off after repeated browser failures and restores the normal interval after success', async () => {
		const date = '2026-11-26';
		const html = await energyPage(date, '00:00 – 24:00 Є світло').text();
		const browser = {
			quickAction: vi
				.fn()
				.mockRejectedValueOnce(new Error('Browser unreachable'))
				.mockResolvedValueOnce(Response.json({}, { status: 503 }))
				.mockImplementation(async () => Response.json({ result: html }, { headers: { 'x-browser-ms-used': '1000' } })),
		};
		const stub = bindings.MONITOR.getByName('test-browser-retry');
		await runInDurableObject(stub, async (_instance, state) => {
			const read = (minute: number) =>
				readBrowserSchedule(browser, state.storage, '10', date, new Date(Date.UTC(2026, 10, 26, 12, minute)));
			await expect(read(0)).rejects.toThrow('Browser unreachable');
			await expect(read(5)).rejects.toThrow('HTTP 503');
			await expect(read(10)).resolves.toBeUndefined();
			await expect(read(15)).resolves.toMatchObject({ today: { date } });
			await expect(read(20)).resolves.toMatchObject({ today: { date } });
			expect(browser.quickAction).toHaveBeenCalledTimes(4);
		});
	});

	it('uses the dated backup when Energy UA is blocked without changing the schedule message', async () => {
		const now = new Date('2026-11-26T15:45:00+02:00');
		let date = '26 листопада';
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (url === source) return new Response(null, { status: 403 });
			expect(url).toBe(backup);
			return new Response(
				`<p>Оновлено ${date} о 13:22 Джерело: сайт Чернівціобленерго</p>
				<h3>Черга 10</h3><p>Сьогодні, ${date} без світла 5 год</p>
				<p>Без світла: 13:00–16:00, 19:00–21:00 · можливо 16:00–16:30, 21:00–21:30</p>
				<p>Завтра Без світла: 00:00–02:00</p>`,
			);
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const card = currentSchedule(await loadSchedule('10', now), now, '10', 'en');
			expect(card).toBe(
				'<b>Chernivtsi · Group 10</b>\n────────────────────\n\n' +
					'<b>NOW</b> · Outage expected\n<b>NEXT</b> · <b>16:00</b> · Supply uncertain\n\n' +
					'<b>Today · THU 26 NOV</b> · <i>Local time</i>\n' +
					'╌ <b>13:00–16:00</b>\n' +
					'╌ <b>16:00–16:30</b> · <i>Supply uncertain</i>\n' +
					'╌ <b>19:00–21:00</b>\n' +
					'╰ <b>21:00–21:30</b> · <i>Supply uncertain</i>',
			);
			date = '25 листопада';
			await expect(loadSchedule('10', now)).rejects.toThrow('HTTP 403');
		} finally {
			warn.mockRestore();
			fetchMock.mockRestore();
		}
	});

	it('lets private chats subscribe and unsubscribe independently in their own language', async () => {
		const secret = await webhookSecret('test-token');
		const now = new Date('2026-11-26T12:00:00+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(now);
		const sends: { chat_id: string; text: string }[] = [];
		let slots = '0'.repeat(48);
		const post = (update_id: number, id: number, text: string) =>
			SELF.fetch('https://example.com/telegram', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify({ update_id, message: { chat: { id, type: 'private' }, text } }),
			});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) return energyPage(date, `00:00 – 24:00 ${slots[0] === '0' ? 'Немає світла' : 'Є світло'}`);
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			sends.push(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			const cron = createScheduledController({ cron: '* * * * *' });
			expect((await post(60, 456, '/start')).status).toBe(204);
			expect(sends[0]).toMatchObject({
				chat_id: '456',
				text: expect.stringContaining('<b>Chernivtsi · Group 10</b>\n────────────────────\n\n<b>Welcome!</b>'),
			});
			await worker.scheduled(cron, bindings);
			expect(sends.filter(({ chat_id }) => chat_id === '456')).toHaveLength(1);

			expect((await post(61, 456, '/uk')).status).toBe(204);
			expect((await post(62, 456, 'Отримувати сповіщення')).status).toBe(204);
			expect(sends.at(-1)).toMatchObject({ chat_id: '456', text: expect.stringContaining('Сповіщення увімкнено') });
			await worker.scheduled(cron, bindings);
			const notices = sends.filter(
				({ text }) => text.includes('<b>First published schedule</b>') || text.includes('<b>Перший опублікований графік</b>'),
			);
			expect(notices).toHaveLength(2);
			expect(notices).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ chat_id: '123', text: expect.stringContaining('Chernivtsi · Group 10') }),
					expect.objectContaining({ chat_id: '456', text: expect.stringContaining('Чернівці · Група 10') }),
				]),
			);

			expect((await post(63, 123, 'Stop alerts')).status).toBe(204);
			expect(sends.at(-1)).toMatchObject({ chat_id: '123', text: expect.stringContaining('Alerts are off') });
			slots = '1'.repeat(48);
			sends.length = 0;
			vi.setSystemTime(now.getTime() + 3 * 60_000);
			await worker.scheduled(cron, bindings);
			expect(sends).toEqual([
				expect.objectContaining({
					chat_id: '456',
					text: expect.stringContaining('Графік оновлено'),
				}),
			]);
			await post(64, 456, '✓ Зміни графіка');
			slots = '0'.repeat(48);
			sends.length = 0;
			vi.setSystemTime(now.getTime() + 6 * 60_000);
			await worker.scheduled(cron, bindings);
			expect(sends).toEqual([]);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('rechecks Energy UA after three minutes or at Kyiv midnight and adds inline status controls', async () => {
		const secret = await webhookSecret('test-token');
		const now = new Date('2026-11-26T23:55:00+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		const sent = vi.fn();
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) {
				const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
				return energyPage(date, Date.now() === now.getTime() ? '00:00 – 24:00 Є світло' : '00:00 – 24:00 Немає світла');
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			expect(String(url)).toMatch(/\/sendMessage$/);
			sent(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			for (const [update_id, text, elapsed, checks] of [
				[71, 'Today', 0, 1],
				[72, '/status', 179_999, 1],
				[73, '/status', 180_000, 2],
				[74, '/tomorrow', 180_001, 2],
				[75, '/status', 300_000, 3],
			] as const) {
				vi.setSystemTime(now.getTime() + elapsed);
				const response = await SELF.fetch('https://example.com/telegram', {
					method: 'POST',
					headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
					body: JSON.stringify({ update_id, message: { chat: { id: 123 }, text } }),
				});
				expect(response.status).toBe(204);
				expect(fetchMock.mock.calls.filter(([url]) => url === source)).toHaveLength(checks);
			}
			expect(sent).toHaveBeenCalledTimes(4);
			expect(sent).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					text: expect.stringContaining('No outages scheduled.'),
					reply_markup: expect.objectContaining({
						inline_keyboard: [
							[
								{ text: 'Change group', callback_data: 'groups' },
								{ text: 'Refresh', callback_data: 'status' },
							],
							[{ text: 'Pause alerts', callback_data: 'pause' }],
						],
					}),
				}),
			);
			expect(sent).toHaveBeenNthCalledWith(3, expect.objectContaining({ text: expect.stringContaining('00:00–24:00') }));
			await worker.scheduled(createScheduledController({ cron: '* * * * *' }), bindings);
			expect(fetchMock.mock.calls.filter(([url]) => url === source)).toHaveLength(3);
			expect(sent).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					text: expect.stringContaining('No outages scheduled.'),
				}),
			);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('updates the same card, shares the selected group with alerts, and renders changes or stale schedules', async () => {
		const secret = await webhookSecret('test-token');
		const now = new Date('2026-11-26T12:45:00+02:00');
		const group11 = energyUaGroups + '11';
		const edits = vi.fn();
		const acknowledgments = vi.fn();
		const sends = vi.fn();
		let outage = 14;
		let offline = false;
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === group11 || url === backup) {
				if (offline || url === backup) return new Response(null, { status: 503 });
				return new Response(
					'<div>Ваша черга <b>11</b></div><script id="schedulePayload">' +
						JSON.stringify({ dates: { today: '26.11.2026' }, today: [{ from: outage * 60, to: 16 * 60, status: 'red' }] }) +
						'</script>',
				);
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			const body = JSON.parse(String(options?.body));
			if (String(url).endsWith('/answerCallbackQuery')) acknowledgments(body);
			else if (String(url).endsWith('/editMessageText')) edits(body);
			else if (String(url).endsWith('/sendMessage')) sends(body);
			else return new Response(null, { status: 503 });
			return Response.json({ ok: true });
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const press = async (update_id: number, data: string) => {
			const response = await SELF.fetch('https://example.com/telegram', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify({ update_id, callback_query: { id: String(update_id), data, message: { message_id: 7, chat: { id: 123 } } } }),
			});
			expect(response.status).toBe(204);
		};
		try {
			await press(80, 'groups');
			expect(edits.mock.lastCall?.[0].reply_markup.inline_keyboard.flat()).toContainEqual({ text: '11', callback_data: 'group:11' });
			await press(81, 'group:11');
			expect(edits.mock.lastCall?.[0]).toMatchObject({ message_id: 7, text: expect.stringContaining('Group 11') });
			await press(81, 'group:11');
			expect(acknowledgments).toHaveBeenCalledTimes(2);
			await press(82, 'pause');
			expect(edits.mock.lastCall?.[0].reply_markup.inline_keyboard[1]).toEqual([{ text: 'Resume alerts', callback_data: 'resume' }]);
			await press(83, 'resume');
			await worker.scheduled(createScheduledController({ cron: '* * * * *' }), bindings);
			expect(sends.mock.lastCall?.[0].text).toContain('Group 11');
			expect(fetchMock.mock.calls.filter(([url]) => url === group11)).toHaveLength(1);
			expect(fetchMock.mock.calls.some(([url]) => url === source)).toBe(false);

			vi.setSystemTime(now.getTime() + 180_000);
			await press(84, 'status');
			expect(edits.mock.lastCall?.[0].text).toContain('<i>No changes</i>');
			outage = 15;
			vi.setSystemTime(now.getTime() + 360_000);
			await press(85, 'status');
			expect(edits.mock.lastCall?.[0].text).toContain('<code>14:00–15:00</code> · Outage expected → Power expected');
			offline = true;
			vi.setSystemTime(now.getTime() + 540_000);
			await press(86, 'status');
			expect(edits.mock.lastCall?.[0].text).toContain('<b>NOW</b> · Status unknown');
			expect(edits.mock.lastCall?.[0].text).toContain('<i>Previous schedule</i>\n╰ <b>15:00–16:00</b>');
			expect(edits.mock.lastCall?.[0].text).toContain('<i>Last update</i> <b>12:51</b>');
		} finally {
			warn.mockRestore();
			fetchMock.mockRestore();
		}
	});

	it('authenticates webhooks and answers a language command once without waiting for cron', async () => {
		expect((await SELF.fetch('https://example.com')).status).toBe(404);
		const post = (secret: string, update_id = 42) =>
			SELF.fetch('https://example.com/telegram', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify({ update_id, message: { chat: { id: 123 }, text: 'language' } }),
			});
		expect((await post('invalid')).status).toBe(403);
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
			expect(JSON.parse(String(options?.body))).toMatchObject({
				chat_id: '123',
				text: expect.stringContaining('Choose your language'),
			});
			return Response.json({ ok: true });
		});
		try {
			const secret = await webhookSecret('test-token');
			const duplicates = await Promise.all([post(secret), post(secret)]);
			expect(duplicates.map(({ status }) => status)).toEqual([204, 204]);
			expect((await post(secret, 44)).status).toBe(204);
			expect((await post(secret)).status).toBe(204);
			expect((await post(secret, 43)).status).toBe(204);
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('replaces a refresh that crosses Kyiv midnight and shares the new schedule with cron', async () => {
		const secret = await webhookSecret('test-token');
		const beforeMidnight = new Date('2026-11-26T23:59:59+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(beforeMidnight);
		const sends = vi.fn();
		let checks = 0;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) {
				if (++checks === 1) {
					vi.setSystemTime(beforeMidnight.getTime() + 1_000);
					return energyPage('2026-11-26', '00:00 – 24:00 Є світло');
				}
				return energyPage('2026-11-27', '00:00 – 24:00 Немає світла');
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			expect(String(url)).toMatch(/\/sendMessage$/);
			sends(JSON.parse(String(options?.body)).text);
			return Response.json({ ok: true });
		});
		try {
			const status = await SELF.fetch('https://example.com/telegram', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify({ update_id: 76, message: { chat: { id: 123 }, text: '/status' } }),
			});
			expect(status.status).toBe(204);
			await worker.scheduled(createScheduledController({ cron: '* * * * *' }), bindings);
			expect(checks).toBe(2);
			expect(sends).toHaveBeenCalledTimes(2);
			for (const [message] of sends.mock.calls) expect(message).toContain('<b>Today · FRI 27 NOV</b>');
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('retries a failed Telegram send and avoids duplicate notices after success', async () => {
		const now = new Date();
		const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(now);
		const telegram = vi
			.fn()
			.mockImplementationOnce(() => Response.json({ ok: false }, { status: 503 }))
			.mockImplementation(() => Response.json({ ok: true }));
		let webhookActive = true;
		const poll = vi.fn(() =>
			webhookActive
				? Response.json({ ok: false, description: 'Conflict: webhook is active' }, { status: 409 })
				: Response.json({ ok: true, result: [] }),
		);
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) return energyPage(date, '00:00 – 24:00 Немає світла');
			if (url === 'https://api.telegram.org/bottest-token/getUpdates') return poll();
			expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
			expect(options?.method).toBe('POST');
			return telegram(JSON.parse(String(options?.body)));
		});

		try {
			const cron = createScheduledController({ cron: '* * * * *' });
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow('Telegram sendMessage failed.');
			await worker.scheduled(cron, bindings);
			await worker.scheduled(cron, bindings);
			expect(poll).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls.filter(([url]) => url === source)).toHaveLength(1);
			webhookActive = false;
			await runInDurableObject(bindings.MONITOR.getByName('chernivtsi'), async (_instance, state) => {
				const key = 'telegram:poll-after:test-token';
				expect(await state.storage.get(key)).toBeGreaterThan(now.getTime());
				await state.storage.put(key, now.getTime() - 1);
			});
			await worker.scheduled(cron, bindings);
			await worker.scheduled(cron, bindings);
			expect(poll).toHaveBeenCalledTimes(3);
			expect(telegram).toHaveBeenCalledTimes(2);
			expect(telegram).toHaveBeenLastCalledWith({
				chat_id: '123',
				parse_mode: 'HTML',
				text: expect.stringContaining('<b>Chernivtsi · Group 10</b>'),
				reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
			});
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('does not send a notice when a chat pauses alerts during the schedule fetch', async () => {
		const now = new Date('2026-11-26T12:00:00+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		const scheduleRequested = Promise.withResolvers<void>();
		const scheduleResponse = Promise.withResolvers<Response>();
		const notice = vi.fn();
		const edit = vi.fn();
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) {
				scheduleRequested.resolve();
				return scheduleResponse.promise;
			}
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			if (String(url).endsWith('/sendMessage')) notice();
			if (String(url).endsWith('/editMessageText')) edit(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			await runInDurableObject(bindings.MONITOR.getByName('chernivtsi'), async (monitor, state) => {
				const cron = monitor.check();
				await scheduleRequested.promise;
				const paused = monitor.webhook({
					update_id: 1,
					callback_query: { id: '1', data: 'pause', message: { message_id: 7, chat: { id: 123 } } },
				});
				try {
					await vi.waitFor(async () => expect(await state.storage.get('telegram:subscribers')).toEqual([]));
				} finally {
					scheduleResponse.resolve(energyPage('2026-11-26', '00:00 – 24:00 Немає світла'));
					await Promise.all([paused, cron]);
				}
			});
			expect(notice).not.toHaveBeenCalled();
			expect(edit.mock.lastCall?.[0].reply_markup.inline_keyboard[1]).toEqual([{ text: 'Resume alerts', callback_data: 'resume' }]);
			expect(fetchMock.mock.calls.filter(([url]) => url === source)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('drops an expired Telegram polling offset and persists the new sequence', async () => {
		const now = new Date('2026-11-26T12:00:00+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		const key = 'telegram:update-offset:test-token';
		await runInDurableObject(bindings.MONITOR.getByName('chernivtsi'), async (_instance, state) => {
			await state.storage.put(key, { offset: 999, updatedAt: now.getTime() - 8 * 24 * 60 * 60_000 });
		});
		const getUpdates = vi.fn<(_: { offset?: number }) => Response>();
		getUpdates.mockImplementationOnce(() => Response.json({ ok: true, result: [{ update_id: 23 }] }));
		getUpdates.mockImplementationOnce(() => Response.json({ ok: true, result: [] }));
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source) return energyPage('2026-11-26', '00:00 – 24:00 Є світло');
			if (String(url).endsWith('/getUpdates')) return getUpdates(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			const cron = createScheduledController({ cron: '* * * * *' });
			await worker.scheduled(cron, bindings);
			await worker.scheduled(cron, bindings);
			expect(getUpdates.mock.calls.map(([body]) => body.offset)).toEqual([undefined, 24]);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('shares one in-flight backup download across groups and parses each separately', async () => {
		const now = new Date('2026-11-26T12:00:00+02:00');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		const send = vi.fn();
		const mirror = vi.fn(async () => {
			await scheduler.wait(20);
			return new Response(
				'<p>Оновлено 26 листопада о 09:30 Джерело: сайт Чернівціобленерго</p>' +
					'<h3>Черга 10</h3><p>Сьогодні, 26 листопада Без світла: 14:00–16:00</p>' +
					'<h3>Черга 11</h3><p>Сьогодні, 26 листопада Без світла: 18:00–20:00</p>',
			);
		});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (String(url).startsWith(energyUaGroups)) return new Response(null, { status: 503 });
			if (url === backup) return mirror();
			if (String(url).endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
			send(JSON.parse(String(options?.body)));
			return Response.json({ ok: true });
		});
		try {
			await runInDurableObject(bindings.MONITOR.getByName('chernivtsi'), async (monitor, state) => {
				await state.storage.put({
					'telegram:subscribers': ['123', '456'],
					'telegram:group:456': '11',
					'energy-ua:browser-usage': { utcDay: '2026-11-26', usedMs: 0, lastAttempt: now.getTime() },
				});
				await monitor.check();
			});
			expect(mirror).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledWith(expect.objectContaining({ chat_id: '123', text: expect.stringContaining('14:00–16:00') }));
			expect(send).toHaveBeenCalledWith(expect.objectContaining({ chat_id: '456', text: expect.stringContaining('18:00–20:00') }));
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('welcomes the configured chat and remembers its language for later commands', async () => {
		const sends: unknown[] = [];
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
			if (url === source || url === backup) return new Response(null, { status: 503 });
			const body = JSON.parse(String(options?.body));
			if (url === 'https://api.telegram.org/bottest-token/getUpdates') {
				const result = body.offset
					? []
					: [
							{ update_id: 1, message: { chat: { id: 456 }, text: '/estado' } },
							{ update_id: 2, message: { chat: { id: 123 }, text: '/start' } },
							{ update_id: 3, message: { chat: { id: 123 }, text: '/language' } },
							{ update_id: 4, message: { chat: { id: 123 }, text: '🇺🇦 Українська' } },
						];
				if (body.offset === 5) result.push({ update_id: 5, message: { chat: { id: 123 }, text: '/estado' } });
				return Response.json({ ok: true, result });
			}
			sends.push(body);
			return Response.json({ ok: true });
		});
		try {
			const cron = createScheduledController({ cron: '* * * * *' });
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow('HTTP 503');
			await expect(worker.scheduled(cron, bindings)).rejects.toThrow('HTTP 503');
			expect(sends).toEqual([
				expect.objectContaining({ chat_id: '123', text: expect.stringContaining('<b>Welcome!</b>') }),
				expect.objectContaining({
					text: '<b>Chernivtsi · Group 10</b>\n────────────────────\n\n<b>Choose your language</b>',
					reply_markup: expect.objectContaining({ keyboard: [[{ text: 'Українська' }, { text: 'English' }]] }),
				}),
				expect.objectContaining({ text: expect.stringContaining('Обрано українську мову') }),
				expect.objectContaining({ parse_mode: 'HTML', text: expect.stringContaining('Актуальний графік наразі недоступний') }),
			]);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe('schedule cards and reminders', () => {
	const now = new Date('2026-11-26T15:45:00+02:00');
	const result = {
		schedule: { today: { date: '2026-11-26', slots: '1'.repeat(28) + '0'.repeat(4) + '1'.repeat(4) + '0'.repeat(2) + '1'.repeat(10) } },
	};

	it('shows the next change to expected power', () => {
		const today = currentSchedule(result, now, '10', 'en');
		expect(today).toContain('<b>NEXT</b> · <b>16:00</b> · Power expected');
		expect(today).toContain('<b>14:00–16:00</b>');
	});

	it('hides completed outages from Today and alerts and keeps future outages', () => {
		const endOfOutage = new Date('2026-11-26T16:00:00+02:00');
		const today = currentSchedule(result, endOfOutage, '10', 'en');
		expect(today).not.toContain('14:00–16:00');
		expect(today).toContain('<b>18:00–19:00</b>');
		const alert = notification(result, endOfOutage, '10', 'en').message;
		expect(alert).not.toContain('14:00–16:00');
		expect(alert).toContain('<b>18:00–19:00</b>');
		const stale = currentSchedule(undefined, endOfOutage, '10', 'en', { stale: result.schedule });
		expect(stale).toContain('<i>Previous schedule</i>');
		expect(stale).not.toContain('14:00–16:00');
		expect(stale).toContain('<b>18:00–19:00</b>');

		const evening = new Date('2026-11-26T21:35:00+02:00');
		expect(currentSchedule(result, evening, '10', 'en')).toContain('No more outages scheduled for today.');
		const ukrainian = currentSchedule(result, evening, '10', 'uk');
		expect(ukrainian).toContain('На сьогодні більше відключень не заплановано.');
		expect(ukrainian).not.toContain('18:00–19:00');
	});

	it('marks the schedule updated even when all revised outages are already over', () => {
		const evening = new Date('2026-11-26T23:00:00+02:00');
		const previous = { schedule: { today: { ...result.schedule.today, slots: '1'.repeat(48) } } };
		const today = currentSchedule(result, evening, '10', 'en', { previous: previous.schedule });
		const alert = notification(result, evening, '10', 'en', previous);
		for (const message of [today, alert.message]) {
			expect(message).toContain('No more outages scheduled for today.\n\n✦ <b>Schedule updated</b>');
			expect(message).not.toContain('14:00–16:00');
			expect(message).not.toContain('18:00–19:00');
		}
		expect(notification(result, evening, '10', 'en', alert.snapshot).message).toBeUndefined();
	});

	it('sends a clear 15-minute return reminder once and honors preferences', () => {
		const previous = { schedule: result.schedule };
		const reminder = notification(result, now, '10', 'en', previous);
		expect(reminder.message).toContain('✦ <b>Power expected back · 16:00</b> · <i>in 15 min</i>');
		expect(reminder.message).toMatch(/^<b>Chernivtsi · Group 10<\/b>\n────────────────────\n\n/u);
		expect(reminder.message).not.toContain('⚡');
		expect(notification(result, now, '10', 'en', reminder.snapshot).message).toBeUndefined();
		expect(notification(result, now, '10', 'en', previous, { ...defaultAlerts, return: false }).message).toBeUndefined();
		expect(notification(result, now, '10', 'en', previous, { ...defaultAlerts, minutes: 5 }).message).toBeUndefined();
	});

	it('remembers a legacy reminder when a revision removes and restores the same transition', () => {
		const previous = { schedule: result.schedule, warning: '2026-11-26 16:00 · 🟢 Suministro previsto' };
		const revised = { schedule: { today: { date: '2026-11-26', slots: '1'.repeat(48) } } };
		const preferences = { ...defaultAlerts, updates: false };
		const { snapshot } = notification(revised, now, '10', 'en', previous, preferences);
		expect(notification(result, now, '10', 'en', snapshot, preferences).message).toBeUndefined();
	});

	it('does not present an uncertain interval as a return and describes revised intervals', () => {
		const uncertain = result.schedule.today.slots.replace(/^(.){32}1/u, (prefix) => prefix.slice(0, -1) + '3');
		const withUncertainty = { ...result, schedule: { ...result.schedule, today: { ...result.schedule.today, slots: uncertain } } };
		const status = currentSchedule(withUncertainty, now, '10', 'en');
		expect(status).toContain('<b>NEXT</b> · <b>16:00</b> · Supply uncertain');
		expect(notification(withUncertainty, now, '10', 'en', { schedule: withUncertainty.schedule }).message).toBeUndefined();
		const revised = notification(
			result,
			now,
			'10',
			'en',
			{
				schedule: { today: { date: '2026-11-26', slots: '1'.repeat(18) + '0'.repeat(2) + '1'.repeat(9) + '0'.repeat(3) + '1'.repeat(16) } },
			},
			{ ...defaultAlerts, return: false },
		);
		expect(revised.message).toContain('✦ <b>Schedule updated</b>');
		expect(revised.message).not.toContain('14:00–14:30');
		expect(revised.message).not.toContain('09:00–10:00');
		expect(revised.message).toContain('<code>18:00–19:00</code> · Power expected → Outage expected');
	});

	it('lists all six schedule transitions and keeps every affected time range', () => {
		const midnight = new Date('2026-11-26T00:00:00+02:00');
		const previous = { today: { date: '2026-11-26', slots: '001133'.repeat(8) } };
		const revised = { schedule: { today: { ...previous.today, slots: '130301'.repeat(8) } } };
		const alert = notification(revised, midnight, '10', 'en', { schedule: previous }).message;
		const today = currentSchedule(revised, midnight, '10', 'en', { previous });
		for (const message of [alert, today]) {
			const changes = message?.split('✦ <b>Schedule updated</b>\n')[1];
			const lines = changes?.split('\n').filter((line) => line.startsWith('<code>')) ?? [];
			expect(lines.map((line) => line.split(' · ')[1])).toEqual([
				'Outage expected → Power expected',
				'Outage expected → Supply uncertain',
				'Power expected → Outage expected',
				'Power expected → Supply uncertain',
				'Supply uncertain → Outage expected',
				'Supply uncertain → Power expected',
			]);
			for (const line of lines) expect(line.match(/<code>/g)).toHaveLength(8);
			expect(lines.at(-1)).toContain('<code>23:30–24:00</code>');
		}

		const ukrainian = notification(revised, midnight, '10', 'uk', { schedule: previous }).message ?? '';
		expect(ukrainian).toContain('✦ <b>Графік оновлено</b>');
		expect(ukrainian).toContain('Електропостачання невизначене → Очікується відключення');
		expect(ukrainian.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(4096);
	});
});
