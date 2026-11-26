import { join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';
import { energyUaGroups, parseEnergyUa, scheduleDate } from './src/energy-ua.ts';

const { OUTAGE_GROUP: group = '10' } = process.env;
if (!/^(?:[1-9]|1[0-2])$/.test(group)) throw new Error('Configure a valid OUTAGE_GROUP.');

const url = energyUaGroups + group;
const browser = await chromium.launchPersistentContext(join(homedir(), '.energy-ua-collector', 'chrome'), {
	channel: 'chrome',
	headless: false,
});
const page = browser.pages()[0] ?? (await browser.newPage());
try {
	console.log('Energy UA check opened Chrome.');
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	await page
		.waitForFunction(() => document.body?.textContent?.includes('Графік на дату'), undefined, { timeout: 45_000 })
		.catch(() => {
			throw new Error('Energy UA did not show the schedule page.');
		});
	if (page.url() !== url) throw new Error('Energy UA did not return the expected group page.');
	const schedule = parseEnergyUa(await page.content(), group, scheduleDate(new Date()));
	console.log('Energy UA schedule verified for group %s on %s.', group, schedule.today.date);
} finally {
	await browser.close();
}
