export type TelegramUpdate = {
	update_id: number;
	message?: { chat: { id: number; type?: string }; text?: string };
	callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number; type?: string } } };
};

async function telegramRequest<Result>(
	token: string,
	method: 'getUpdates' | 'sendMessage' | 'editMessageText' | 'answerCallbackQuery',
	body: object,
): Promise<Result | undefined> {
	let response: Response | undefined;
	const signal = AbortSignal.timeout(8_000);
	try {
		response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		const data = await response.json<{ ok: boolean; result: Result; description?: string }>();
		if (method === 'getUpdates' && response.status === 409 && data.description?.includes('webhook is active')) {
			return undefined;
		}
		if (response.status === 400 && method === 'editMessageText' && data.description?.includes('message is not modified')) return;
		if (response.status === 400 && method === 'answerCallbackQuery' && data.description?.includes('query is too old')) return;
		if (!response.ok || !data.ok) throw new Error();
		if (method === 'getUpdates' && !Array.isArray(data.result)) throw new Error();
		return data.result;
	} catch {
		const reason = signal.aborted
			? 'Request timed out.'
			: !response
				? 'Network request failed.'
				: response.ok
					? 'Invalid API response.'
					: 'HTTP ' + response.status + '.';
		throw new Error('Telegram ' + method + ' failed. ' + reason);
	}
}

export function getUpdates(token: string, offset?: number) {
	return telegramRequest<TelegramUpdate[]>(token, 'getUpdates', {
		offset,
		limit: 10,
		allowed_updates: ['message', 'callback_query'],
	});
}

export async function webhookSecret(token: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('telegram-webhook:' + token));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sendMessage(token: string, chatId: string, text: string, replyMarkup?: object) {
	return telegramRequest(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
}

export function editMessage(token: string, chatId: string, messageId: number, text: string, replyMarkup: object) {
	return telegramRequest(token, 'editMessageText', {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: 'HTML',
		reply_markup: replyMarkup,
	});
}

export function answerCallback(token: string, id: string) {
	return telegramRequest(token, 'answerCallbackQuery', { callback_query_id: id });
}
