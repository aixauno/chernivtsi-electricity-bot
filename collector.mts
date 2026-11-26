import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, errors } from 'playwright-core';
import { energyUaGroups, parseEnergyUa, scheduleDate } from './src/energy-ua.ts';

const { OUTAGE_GROUP: group = '10' } = process.env;
if (!/^(?:[1-9]|1[0-2])$/.test(group)) throw new Error('Configure a valid OUTAGE_GROUP.');

const url = energyUaGroups + group;
const browser = await chromium.launchPersistentContext(join(homedir(), '.energy-ua-collector', 'chrome'), {
	channel: 'chrome',
	headless: false,
});
try {
	const page = browser.pages()[0] ?? (await browser.newPage());
	console.log('Energy UA check opened Chrome.');
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	} catch (error) {
		if (!(error instanceof errors.TimeoutError)) throw error;
		throw new Error('Energy UA did not finish loading within 30 seconds.', { cause: error });
	}
	const deadline = performance.now() + 45_000;
	let verificationError: unknown;
	let schedule: ReturnType<typeof parseEnergyUa> | undefined;
	do {
		try {
			const html = await page.evaluate((expectedUrl) => {
				if (location.href !== expectedUrl) return;
				if (document.getElementById('schedulePayload') || document.body?.textContent?.includes('Графік на дату')) {
					return document.documentElement.outerHTML;
				}
			}, url);
			if (html) {
				schedule = parseEnergyUa(html, group, scheduleDate(new Date()));
				break;
			}
		} catch (error) {
			if (page.isClosed()) throw error;
			verificationError = error;
		}
		await delay(Math.max(0, Math.min(500, deadline - performance.now())));
	} while (performance.now() < deadline);
	if (!schedule) {
		throw new Error('Energy UA did not show a verified schedule on the expected group page within 45 seconds.', {
			cause: verificationError,
		});
	}
	console.log('Energy UA schedule verified for group %s on %s.', group, schedule.today.date);
} finally {
	await browser.close();
}
