import { DurableObject } from 'cloudflare:workers';
import { scheduleDate } from './energy-ua';
import { readBrowserSchedule } from './energy-ua-browser';
import {
	alertMenu,
	defaultAlerts,
	languageMenu,
	menu,
	formatMessage,
	messages,
	parseCommand,
	type AlertPreferences,
	type Language,
} from './messages';
import { currentSchedule, loadSchedule, notification, type Snapshot, type VerifiedSchedule } from './schedule';
import { getUpdates, sendMessage, webhookSecret, type TelegramUpdate } from './telegram';

type BotEnv = Omit<Env, 'MONITOR' | 'OUTAGE_GROUP'> & {
	MONITOR: DurableObjectNamespace<ElectricityMonitor>;
	OUTAGE_GROUP: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
};

const subscriberKey = 'telegram:subscribers';
const scheduleCheckIntervalMs = 3 * 60_000;
const webhookPollingIntervalMs = 5 * 60_000;

type ScheduleCheck = { date: string; checkedAt: number } & ({ result: VerifiedSchedule } | { error: string });

async function subscribers(storage: Pick<DurableObjectStorage, 'get'>, owner: string): Promise<string[]> {
	const saved = await storage.get<string[]>(subscriberKey);
	if (saved) return saved;
	const previousRecipients = (await storage.get<string[]>('telegram:recipients')) ?? [];
	return [...new Set([owner, ...previousRecipients])];
}

export class ElectricityMonitor extends DurableObject<BotEnv> {
	private running?: Promise<void>;
	private scheduleRefresh?: Promise<ScheduleCheck>;

	async check(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.poll();
		try {
			await this.running;
		} finally {
			this.running = undefined;
		}
	}

	async webhook(update: TelegramUpdate): Promise<void> {
		const key = 'telegram:webhook:' + this.env.TELEGRAM_BOT_TOKEN?.split(':')[0];
		if ((await this.ctx.storage.get<number>(key)) === update.update_id) return;
		await this.reply(update);
		await this.ctx.storage.put(key, update.update_id);
	}

	private async getSchedule(group: string, now: Date): Promise<VerifiedSchedule> {
		const date = scheduleDate(now);
		const key = 'schedule:checked:' + group;
		let check = await this.ctx.storage.get<ScheduleCheck>(key);
		while (check?.date !== date || now.getTime() - check.checkedAt >= scheduleCheckIntervalMs) {
			this.scheduleRefresh ??= this.refreshSchedule(key, group, now, date).finally(() => {
				this.scheduleRefresh = undefined;
			});
			check = await this.scheduleRefresh;
		}
		if ('error' in check) throw new Error(check.error);
		return check.result;
	}

	private async refreshSchedule(key: string, group: string, now: Date, date: string): Promise<ScheduleCheck> {
		const checkedAt = now.getTime();
		const check = await loadSchedule(group, now, (day) => readBrowserSchedule(this.env.BROWSER, this.ctx.storage, group, day, now)).then(
			(result): ScheduleCheck => ({ date, checkedAt, result }),
			(error: unknown): ScheduleCheck => ({ date, checkedAt, error: error instanceof Error ? error.message : String(error) }),
		);
		await this.ctx.storage.put(key, check);
		return check;
	}

	private async poll(): Promise<void> {
		const { OUTAGE_GROUP: group, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = this.env;
		if (!/^[1-9]\d?$/.test(group) || !token || !chatId || !/^-?\d+$/.test(chatId)) {
			throw new Error('Missing or invalid outage group or Telegram configuration.');
		}
		const now = new Date();
		const [result, commands] = await Promise.allSettled([this.getSchedule(group, now), this.readCommands(token, now)]);
		if (result.status === 'rejected') throw result.reason;
		const recipients = await subscribers(this.ctx.storage, chatId);
		const deliveries = await Promise.allSettled(recipients.map((recipient) => this.sendNotice(token, recipient, group, now, result.value)));
		for (const delivery of deliveries) if (delivery.status === 'rejected') throw delivery.reason;
		if (commands.status === 'rejected') throw commands.reason;
	}

	private async reply(update: TelegramUpdate): Promise<void> {
		const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: owner, OUTAGE_GROUP: group } = this.env;
		const message = update.message;
		if (!token || !owner || !message || !Number.isSafeInteger(message.chat?.id) || typeof message.text !== 'string') return;
		const chatId = String(message.chat.id);
		const command = parseCommand(message.text);
		if (!command) return;
		if (chatId !== owner && message.chat.type !== 'private') return;

		const languageKey = 'telegram:language:' + chatId;
		if (command === 'en' || command === 'uk') {
			await this.ctx.storage.put(languageKey, command);
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			await sendMessage(token, chatId, formatMessage(group, command, messages[command].saved), menu(command, active));
			return;
		}
		const language = (await this.ctx.storage.get<Language>(languageKey)) ?? 'en';
		const copy = messages[language];
		if (command === 'alerts' || typeof command === 'object') {
			const key = 'telegram:alerts:' + chatId;
			const preferences = await this.ctx.storage.transaction(async (storage) => {
				const saved = { ...defaultAlerts, ...(await storage.get<AlertPreferences>(key)) };
				if (command === 'alerts') return saved;
				const updated =
					command.type === 'leadTime' ? { ...saved, minutes: command.minutes } : { ...saved, [command.kind]: command.enabled };
				await storage.put(key, updated);
				return updated;
			});
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			const text = copy.alertSettings + (active ? '' : '\n\n' + copy.alertsPaused);
			await sendMessage(token, chatId, formatMessage(group, language, text), alertMenu(language, preferences));
		} else if (command === 'subscribe' || command === 'unsubscribe') {
			const active = command === 'subscribe';
			await this.ctx.storage.transaction(async (storage) => {
				const current = await subscribers(storage, owner);
				if (current.includes(chatId) === active) return;
				const updated = active ? [...current, chatId] : current.filter((recipient) => recipient !== chatId);
				await storage.put(subscriberKey, updated);
			});
			await sendMessage(
				token,
				chatId,
				formatMessage(group, language, active ? copy.subscribed : copy.unsubscribed),
				menu(language, active),
			);
		} else if (command === 'help' || command === 'back') {
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			const guide = formatMessage(group, language, copy.welcome);
			await sendMessage(token, chatId, guide, menu(language, active));
		} else if (command === 'language') {
			await sendMessage(token, chatId, formatMessage(group, language, copy.language), languageMenu);
		} else {
			const now = new Date();
			const status = await this.getSchedule(group, now).then(
				(schedule) => currentSchedule(schedule, now, group, language),
				() => formatMessage(group, language, copy.unavailable),
			);
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			await sendMessage(token, chatId, status, menu(language, active));
		}
	}

	private async readCommands(token: string, now: Date): Promise<void> {
		const botId = token.split(':')[0];
		const retryKey = 'telegram:poll-after:' + botId;
		const retryAt = await this.ctx.storage.get<number>(retryKey);
		if (retryAt !== undefined && now.getTime() < retryAt) return;
		const key = 'telegram:update-offset:' + botId;
		const offset = await this.ctx.storage.get<number>(key);
		const updates = await getUpdates(token, offset);
		if (!updates) {
			await this.ctx.storage.put(retryKey, now.getTime() + webhookPollingIntervalMs);
			return;
		}
		if (retryAt !== undefined) await this.ctx.storage.delete(retryKey);
		for (const update of updates) {
			await this.reply(update);
			await this.ctx.storage.put(key, update.update_id + 1);
		}
	}

	private async sendNotice(token: string, chatId: string, group: string, now: Date, schedule: VerifiedSchedule): Promise<void> {
		const language = (await this.ctx.storage.get<Language>('telegram:language:' + chatId)) ?? 'en';
		const key = 'schedule:' + group + ':' + chatId;
		const previous = await this.ctx.storage.get<Snapshot>(key);
		const preferences = await this.ctx.storage.get<AlertPreferences>('telegram:alerts:' + chatId);
		const { snapshot, message } = notification(schedule, now, group, language, previous, preferences);
		if (message) await sendMessage(token, chatId, message);
		if (JSON.stringify(snapshot) !== JSON.stringify(previous)) await this.ctx.storage.put(key, snapshot);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/telegram') {
			return new Response(null, { status: 404 });
		}
		const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
		if (!env.TELEGRAM_BOT_TOKEN || !secret || secret !== (await webhookSecret(env.TELEGRAM_BOT_TOKEN))) {
			return new Response(null, { status: 403 });
		}
		const update = await request.json<TelegramUpdate | null>().catch(() => null);
		if (!update || !Number.isSafeInteger(update.update_id)) return new Response(null, { status: 400 });
		await env.MONITOR.getByName('chernivtsi').webhook(update);
		return new Response(null, { status: 204 });
	},
	async scheduled(_controller, env): Promise<void> {
		await env.MONITOR.getByName('chernivtsi').check();
	},
} satisfies ExportedHandler<BotEnv>;
