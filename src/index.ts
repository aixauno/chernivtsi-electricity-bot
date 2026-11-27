import { DurableObject } from 'cloudflare:workers';
import { scheduleDate, type Day } from './energy-ua';
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
import { answerCallback, editMessage, getUpdates, sendMessage, webhookSecret, type TelegramUpdate } from './telegram';

type BotEnv = Omit<Env, 'MONITOR' | 'OUTAGE_GROUP'> & {
	MONITOR: DurableObjectNamespace<ElectricityMonitor>;
	OUTAGE_GROUP: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
};

const subscriberKey = 'telegram:subscribers';
const legacyRecipientKey = 'telegram:recipients';
const scheduleCheckIntervalMs = 3 * 60_000;
const webhookPollingIntervalMs = 5 * 60_000;
const processedUpdateLifetimeMs = 2 * 24 * 60 * 60_000;
const pollingOffsetLifetimeMs = 24 * 60 * 60_000;

type PollingOffset = { offset: number; updatedAt: number };

type SuccessfulCheck = { checkedAt: number; result: VerifiedSchedule; observedBackup?: Day; retainedAt?: number };
type ScheduleCheck = { date: string } & (SuccessfulCheck | { checkedAt: number; error: string; lastSuccess?: SuccessfulCheck });

async function subscribers(storage: Pick<DurableObjectStorage, 'get'>, owner: string): Promise<string[]> {
	const saved = await storage.get<string[]>(subscriberKey);
	if (saved) return saved;
	const previousRecipients = (await storage.get<string[]>(legacyRecipientKey)) ?? [];
	return [...new Set([owner, ...previousRecipients])];
}

async function setAlerts(storage: DurableObjectStorage, owner: string, chatId: string, active: boolean) {
	await storage.transaction(async (transaction) => {
		const current = await subscribers(transaction, owner);
		if (current.includes(chatId) === active) return;
		await transaction.put(subscriberKey, active ? [...current, chatId] : current.filter((recipient) => recipient !== chatId));
	});
}

export class ElectricityMonitor extends DurableObject<BotEnv> {
	private running?: Promise<void>;
	private scheduleRefresh?: Promise<ScheduleCheck>;
	private readonly updatesInFlight = new Map<number, Promise<void>>();
	private readonly chatOperations = new Map<string, Promise<void>>();

	constructor(ctx: DurableObjectState, env: BotEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const { sql } = ctx.storage;
			sql.exec(`CREATE TABLE IF NOT EXISTS telegram_updates (
				bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, processed_at INTEGER NOT NULL,
				PRIMARY KEY (bot_id, update_id)
			)`);
			sql.exec('CREATE INDEX IF NOT EXISTS telegram_updates_by_time ON telegram_updates (processed_at)');
			const botId = env.TELEGRAM_BOT_TOKEN?.split(':')[0];
			if (!botId) return;
			const legacyKey = 'telegram:webhook:' + botId;
			const lastUpdate = await ctx.storage.get<number>(legacyKey);
			if (lastUpdate === undefined) return;
			sql.exec('INSERT OR IGNORE INTO telegram_updates VALUES (?, ?, ?)', botId, lastUpdate, Date.now());
			await ctx.storage.delete(legacyKey);
		});
	}

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
		const token = this.env.TELEGRAM_BOT_TOKEN;
		if (token && (update.message || update.callback_query)) await this.processUpdate(token.split(':')[0], update);
	}

	private async processUpdate(botId: string, update: TelegramUpdate): Promise<void> {
		const id = update.update_id;
		const pending = this.updatesInFlight.get(id);
		if (pending) return pending;
		const processing = this.replyOnce(botId, update);
		this.updatesInFlight.set(id, processing);
		try {
			await processing;
		} finally {
			this.updatesInFlight.delete(id);
		}
	}

	private async replyOnce(botId: string, update: TelegramUpdate): Promise<void> {
		const { sql } = this.ctx.storage;
		const id = update.update_id;
		if (
			sql
				.exec(
					'SELECT 1 FROM telegram_updates WHERE bot_id = ? AND update_id = ? AND processed_at > ?',
					botId,
					id,
					Date.now() - processedUpdateLifetimeMs,
				)
				.toArray().length
		)
			return;
		const chat = update.callback_query?.message?.chat ?? update.message?.chat;
		const token = this.env.TELEGRAM_BOT_TOKEN;
		const callbackId = update.callback_query?.id;
		const acknowledgment =
			token && typeof callbackId === 'string'
				? answerCallback(token, callbackId).catch((error: Error) => console.warn(error.message))
				: undefined;
		if (chat && Number.isSafeInteger(chat.id)) {
			await this.forChat(String(chat.id), () => this.reply(update));
		}
		await acknowledgment;
		const now = Date.now();
		sql.exec('DELETE FROM telegram_updates WHERE processed_at <= ?', now - processedUpdateLifetimeMs);
		sql.exec('INSERT OR REPLACE INTO telegram_updates VALUES (?, ?, ?)', botId, id, now);
	}

	private async forChat(chatId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.chatOperations.get(chatId);
		const pending = previous ? previous.catch(() => {}).then(operation) : operation();
		this.chatOperations.set(chatId, pending);
		try {
			await pending;
		} finally {
			if (this.chatOperations.get(chatId) === pending) this.chatOperations.delete(chatId);
		}
	}

	private async getSchedule(): Promise<{ check: ScheduleCheck; now: Date }> {
		const group = this.env.OUTAGE_GROUP;
		const key = 'schedule:checked:' + group;
		let check = await this.ctx.storage.get<ScheduleCheck>(key);
		let refreshed = false;
		for (;;) {
			const now = new Date();
			const date = scheduleDate(now);
			if (check?.date === date && (refreshed || now.getTime() - check.checkedAt < scheduleCheckIntervalMs)) return { check, now };
			this.scheduleRefresh ??= this.refreshSchedule(key, group, now, date, check).finally(() => {
				this.scheduleRefresh = undefined;
			});
			check = await this.scheduleRefresh;
			refreshed = true;
		}
	}

	private async refreshSchedule(key: string, group: string, now: Date, date: string, previous?: ScheduleCheck): Promise<ScheduleCheck> {
		const checkedAt = now.getTime();
		const lastSuccess = previous && ('result' in previous ? previous : previous.lastSuccess);
		const check = await loadSchedule(group, now, (day) => readBrowserSchedule(this.env.BROWSER, this.ctx.storage, group, day, now)).then(
			(result): ScheduleCheck => {
				const lastDay = lastSuccess?.result.schedule.today;
				const observedBackup = lastSuccess?.observedBackup ?? (lastSuccess?.result.source === 'mirror' ? lastDay : undefined);
				if (result.source !== 'mirror') {
					return { date, checkedAt, result, observedBackup: observedBackup?.date === date ? observedBackup : undefined };
				}
				const reported = result.schedule.today;
				if (
					lastSuccess &&
					lastDay?.date === date &&
					observedBackup?.date === date &&
					observedBackup.slots === reported.slots &&
					lastDay.slots !== reported.slots
				) {
					return {
						date,
						checkedAt,
						result: lastSuccess.result,
						observedBackup,
						retainedAt: lastSuccess.retainedAt ?? lastSuccess.checkedAt,
					};
				}
				return { date, checkedAt, result, observedBackup: reported };
			},
			(error: unknown): ScheduleCheck => ({ date, checkedAt, error: error instanceof Error ? error.message : String(error), lastSuccess }),
		);
		await this.ctx.storage.put(key, check);
		return check;
	}

	private async poll(): Promise<void> {
		const { OUTAGE_GROUP: group, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = this.env;
		if (!/^[1-9]\d?$/.test(group) || !token || !chatId || !/^-?\d+$/.test(chatId)) {
			throw new Error('Missing or invalid outage group or Telegram configuration.');
		}
		const results = await Promise.allSettled([this.pollNotices(token, chatId, group), this.readCommands(token, new Date())]);
		for (const result of results) if (result.status === 'rejected') throw result.reason;
	}

	private async pollNotices(token: string, chatId: string, group: string) {
		const recipients = await subscribers(this.ctx.storage, chatId);
		const { check } = await this.getSchedule();
		let accepted: SuccessfulCheck;
		if ('result' in check) accepted = check;
		else if (check.lastSuccess?.result.schedule.today.date === check.date) accepted = check.lastSuccess;
		else throw new Error(check.error);
		const deliveries = await Promise.allSettled(
			recipients.map((chat) => this.forChat(chat, () => this.sendNotice(token, chatId, chat, group, accepted))),
		);
		for (const delivery of deliveries) if (delivery.status === 'rejected') throw delivery.reason;
	}

	private async reply(update: TelegramUpdate): Promise<void> {
		const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: owner, OUTAGE_GROUP: group } = this.env;
		if (!token || !owner) return;
		if (update.callback_query) return this.replyToCallback(token, owner, group, update.callback_query);
		const message = update.message;
		if (!message || !Number.isSafeInteger(message.chat?.id) || typeof message.text !== 'string') return;
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
			const preferences =
				command === 'alerts'
					? { ...defaultAlerts, ...(await this.ctx.storage.get<AlertPreferences>(key)) }
					: await this.ctx.storage.transaction(async (storage) => {
							const saved = { ...defaultAlerts, ...(await storage.get<AlertPreferences>(key)) };
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
			await setAlerts(this.ctx.storage, owner, chatId, active);
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
			const status = await this.status(group, language);
			await sendMessage(token, chatId, status);
		}
	}

	private async status(group: string, language: Language) {
		const { check, now } = await this.getSchedule();
		if ('result' in check && check.retainedAt === undefined) {
			return currentSchedule(check.result, now, group, language, { checkedAt: check.checkedAt });
		}
		const lastSuccess = 'result' in check ? check : check.lastSuccess;
		return currentSchedule(undefined, now, group, language, {
			checkedAt: lastSuccess?.retainedAt ?? lastSuccess?.checkedAt,
			stale: lastSuccess?.result.schedule,
		});
	}

	private async replyToCallback(token: string, owner: string, group: string, callback: NonNullable<TelegramUpdate['callback_query']>) {
		if (typeof callback.id !== 'string') return;
		const { message, data } = callback;
		if (!message || !Number.isSafeInteger(message.chat?.id) || !Number.isSafeInteger(message.message_id) || typeof data !== 'string')
			return;
		const chatId = String(message.chat.id);
		if (chatId !== owner && message.chat.type !== 'private') return;
		if (!['status', 'pause', 'resume'].includes(data)) return;
		const language = (await this.ctx.storage.get<Language>('telegram:language:' + chatId)) ?? 'en';
		if (data === 'pause' || data === 'resume') await setAlerts(this.ctx.storage, owner, chatId, data === 'resume');
		const status = await this.status(group, language);
		await editMessage(token, chatId, message.message_id, status, { inline_keyboard: [] });
	}

	private async readCommands(token: string, now: Date): Promise<void> {
		const botId = token.split(':')[0];
		const retryKey = 'telegram:poll-after:' + botId;
		const key = 'telegram:update-offset:' + botId;
		const state = await this.ctx.storage.get<number | PollingOffset>([retryKey, key]);
		const retryAt = state.get(retryKey) as number | undefined;
		if (retryAt !== undefined && now.getTime() < retryAt) return;
		const saved = state.get(key);
		// Telegram can start a new sequence after a week without updates.
		const offset = typeof saved === 'object' && now.getTime() - saved.updatedAt < pollingOffsetLifetimeMs ? saved.offset : undefined;
		const updates = await getUpdates(token, offset);
		if (!updates) {
			await this.ctx.storage.put(retryKey, now.getTime() + webhookPollingIntervalMs);
			return;
		}
		if (retryAt !== undefined) await this.ctx.storage.delete(retryKey);
		for (const update of updates) {
			await this.processUpdate(botId, update);
			await this.ctx.storage.put(key, { offset: update.update_id + 1, updatedAt: Date.now() } satisfies PollingOffset);
		}
	}

	private async sendNotice(token: string, owner: string, chatId: string, group: string, check: SuccessfulCheck): Promise<void> {
		const key = 'schedule:' + group + ':' + chatId;
		const languageKey = 'telegram:language:' + chatId;
		const preferencesKey = 'telegram:alerts:' + chatId;
		const state = await this.ctx.storage.get<string | string[] | Snapshot | AlertPreferences>([
			key,
			languageKey,
			preferencesKey,
			subscriberKey,
		]);
		const recipients = state.get(subscriberKey) as string[] | undefined;
		const subscribed =
			recipients?.includes(chatId) ?? (chatId === owner || (await this.ctx.storage.get<string[]>(legacyRecipientKey))?.includes(chatId));
		if (!subscribed) return;
		const now = new Date();
		if (check.result.schedule.today.date !== scheduleDate(now)) return;
		const language = (state.get(languageKey) as Language | undefined) ?? 'en';
		const previous = state.get(key) as Snapshot | undefined;
		const preferences = state.get(preferencesKey) as AlertPreferences | undefined;
		const notice = notification(check.result, now, group, language, previous, preferences);
		for (const { text, snapshot } of notice.messages) {
			await sendMessage(token, chatId, text);
			await this.ctx.storage.put(key, snapshot);
		}
		if (!notice.messages.length && JSON.stringify(notice.snapshot) !== JSON.stringify(previous)) {
			await this.ctx.storage.put(key, notice.snapshot);
		}
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
