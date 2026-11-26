export type TelegramUpdate = {
	update_id: number;
	message?: { chat: { id: number; type?: string }; text?: string };
};

async function telegramRequest<Result>(token: string, method: "getUpdates" | "sendMessage", body: object): Promise<Result | undefined> {
	try {
		const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(8_000),
		});
		const data = await response.json<{ ok: boolean; result: Result; description?: string }>();
		if (method === "getUpdates" && response.status === 409 && data.description?.includes("webhook is active")) {
			return undefined;
		}
		if (!response.ok || !data.ok) throw new Error();
		return data.result;
	} catch {
		throw new Error("Telegram " + method + " failed.");
	}
}

export async function getUpdates(token: string, offset?: number): Promise<TelegramUpdate[]> {
	return (await telegramRequest<TelegramUpdate[]>(token, "getUpdates", {
		offset, limit: 10, allowed_updates: ["message"],
	})) ?? [];
}

export async function webhookSecret(token: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("telegram-webhook:" + token));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sendMessage(token: string, chatId: string, text: string, replyMarkup?: object) {
	return telegramRequest(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup });
}
