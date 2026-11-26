import { DurableObject } from "cloudflare:workers";
import { languageMenu, menu, messageHeader, messages, parseCommand, type Language } from "./messages";
import { checkedCollection, type CollectedSchedule } from "./official";
import { currentSchedule, loadSchedule, notification, PublishedSchedule, type Schedule, type Snapshot } from "./schedule";
import { getUpdates, sendMessage, webhookSecret, type TelegramUpdate } from "./telegram";

type BotEnv = Omit<Env, "MONITOR" | "OUTAGE_GROUP"> & {
	MONITOR: DurableObjectNamespace<ElectricityMonitor>;
	OUTAGE_GROUP: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	SCHEDULE_COLLECTOR_TOKEN?: string;
};

const subscriberKey = "telegram:subscribers";
const collectionKey = "schedule:official-collection";

async function subscribers(storage: Pick<DurableObjectStorage, "get">, owner: string): Promise<string[]> {
	const saved = await storage.get<string[]>(subscriberKey);
	if (saved) return saved;
	const previousRecipients = await storage.get<string[]>("telegram:recipients") ?? [];
	return [...new Set([owner, ...previousRecipients])];
}

export class ElectricityMonitor extends DurableObject<BotEnv> {
	private running?: Promise<void>;

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
		const key = "telegram:webhook:" + this.env.TELEGRAM_BOT_TOKEN?.split(":")[0];
		if (await this.ctx.storage.get<number>(key) === update.update_id) return;
		const now = new Date();
		await this.reply(update, now, () => this.getSchedule(now));
		await this.ctx.storage.put(key, update.update_id);
	}

	async recordCollection(collection: CollectedSchedule): Promise<boolean> {
		return this.ctx.storage.transaction(async (storage) => {
			const previous = await storage.get<CollectedSchedule>(collectionKey);
			if (previous?.group === collection.group && previous.fetchedAt >= collection.fetchedAt) return false;
			await storage.put(collectionKey, collection);
			return JSON.stringify(previous?.schedule) !== JSON.stringify(collection.schedule);
		});
	}

	private async getSchedule(now: Date): Promise<Schedule> {
		const group = this.env.OUTAGE_GROUP;
		const collection = checkedCollection(await this.ctx.storage.get(collectionKey), group, now);
		return loadSchedule(group, now, collection?.schedule);
	}

	private async poll(): Promise<void> {
		const { OUTAGE_GROUP: group, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = this.env;
		if (!/^[1-9]\d?$/.test(group) || !token || !chatId || !/^-?\d+$/.test(chatId)) {
			throw new Error("Missing or invalid outage group or Telegram configuration.");
		}
		const now = new Date();
		const scheduleResult = this.getSchedule(now)
			.then((schedule) => ({ schedule }), (error: unknown) => ({ error }));
		const [commands] = await Promise.allSettled([this.readCommands(token, async (update) => {
			await this.reply(update, now, async () => {
				const result = await scheduleResult;
				if ("error" in result) throw result.error;
				return result.schedule;
			});
		})]);
		const result = await scheduleResult;
		if ("error" in result) throw result.error;
		const recipients = await subscribers(this.ctx.storage, chatId);
		const deliveries = await Promise.allSettled(
			recipients.map((recipient) => this.sendNotice(token, recipient, group, now, result.schedule)),
		);
		for (const delivery of deliveries) if (delivery.status === "rejected") throw delivery.reason;
		if (commands.status === "rejected") throw commands.reason;
	}

	private async reply(update: TelegramUpdate, now: Date, getSchedule: () => Promise<Schedule>): Promise<void> {
		const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: owner, OUTAGE_GROUP: group } = this.env;
		const message = update.message;
		if (!token || !owner || !message || !Number.isSafeInteger(message.chat?.id) || typeof message.text !== "string") return;
		const chatId = String(message.chat.id);
		const command = parseCommand(message.text);
		if (!command) return;
		if (chatId !== owner && message.chat.type !== "private") return;

		const languageKey = "telegram:language:" + chatId;
		if (command === "en" || command === "uk") {
			await this.ctx.storage.put(languageKey, command);
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			await sendMessage(token, chatId, messages[command].saved, menu(command, active));
			return;
		}
		const language = await this.ctx.storage.get<Language>(languageKey) ?? "en";
		const copy = messages[language];
		if (command === "subscribe" || command === "unsubscribe") {
			const active = command === "subscribe";
			await this.ctx.storage.transaction(async (storage) => {
				const current = await subscribers(storage, owner);
				if (current.includes(chatId) === active) return;
				const updated = active ? [...current, chatId] : current.filter((recipient) => recipient !== chatId);
				await storage.put(subscriberKey, updated);
			});
			await sendMessage(token, chatId, active ? copy.subscribed : copy.unsubscribed, menu(language, active));
		} else if (command === "help") {
			const active = (await subscribers(this.ctx.storage, owner)).includes(chatId);
			const guide = messageHeader(group, language) + "\n\n" + copy.welcome;
			await sendMessage(token, chatId, guide, menu(language, active));
		} else if (command === "language") {
			await sendMessage(token, chatId, copy.language, languageMenu);
		} else {
			const status = await getSchedule().then(
				(schedule) => currentSchedule(schedule, now, group, language),
				(error: unknown) => messageHeader(group, language) + "\n\n" + (error instanceof PublishedSchedule
					? copy.published + `\n<a href="${error.url}">${copy.officialPost}</a>`
					: copy.unavailable),
			);
			await sendMessage(token, chatId, status);
		}
	}

	private async readCommands(token: string, reply: (update: TelegramUpdate) => Promise<void>) {
		const key = "telegram:update-offset:" + token.split(":")[0];
		const offset = await this.ctx.storage.get<number>(key);
		for (const update of await getUpdates(token, offset)) {
			await reply(update);
			await this.ctx.storage.put(key, update.update_id + 1);
		}
	}

	private async sendNotice(token: string, chatId: string, group: string, now: Date, schedule: Schedule): Promise<void> {
		const language = await this.ctx.storage.get<Language>("telegram:language:" + chatId) ?? "en";
		const key = "schedule:" + group + ":" + chatId;
		const previous = await this.ctx.storage.get<Snapshot>(key);
		const { snapshot, message } = notification(schedule, now, group, language, previous);
		if (message) await sendMessage(token, chatId, message);
		if (JSON.stringify(snapshot) !== JSON.stringify(previous)) await this.ctx.storage.put(key, snapshot);
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === "POST" && new URL(request.url).pathname === "/schedule-collector") {
			const token = env.SCHEDULE_COLLECTOR_TOKEN;
			if (!token || request.headers.get("Authorization") !== "Bearer " + token) {
				return new Response(null, { status: 403 });
			}
			const collection = checkedCollection(await request.json().catch(() => null), env.OUTAGE_GROUP, new Date());
			if (!collection) return new Response(null, { status: 400 });
			const monitor = env.MONITOR.getByName("chernivtsi");
			if (await monitor.recordCollection(collection)) ctx.waitUntil(monitor.check());
			return new Response(null, { status: 204 });
		}
		if (request.method !== "POST" || new URL(request.url).pathname !== "/telegram") {
			return new Response(null, { status: 404 });
		}
		const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
		if (!env.TELEGRAM_BOT_TOKEN || !secret || secret !== await webhookSecret(env.TELEGRAM_BOT_TOKEN)) {
			return new Response(null, { status: 403 });
		}
		const update = await request.json<TelegramUpdate | null>().catch(() => null);
		if (!update || !Number.isSafeInteger(update.update_id)) return new Response(null, { status: 400 });
		await env.MONITOR.getByName("chernivtsi").webhook(update);
		return new Response(null, { status: 204 });
	},
	async scheduled(_controller, env): Promise<void> {
		await env.MONITOR.getByName("chernivtsi").check();
	},
} satisfies ExportedHandler<BotEnv>;

