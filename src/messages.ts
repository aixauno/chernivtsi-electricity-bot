export type Language = 'en' | 'uk';

export const messages = {
	en: {
		title: (group: string) => `Chernivtsi · Group ${group}`,
		localTime: 'Local time',
		reminderTime: 'Kyiv time',
		todayButton: 'Today',
		alertsButton: 'Alert settings',
		backButton: 'Back',
		alertLabels: { updates: 'Schedule changes', cutoff: 'Outage reminder', return: 'Power return reminder' },
		leadTime: (minutes: number) => `${minutes} min before`,
		alertSettings: '<b>Alert settings</b>\nChoose which alerts to receive.',
		alertsPaused: 'All alerts are paused. Turn alerts on to receive your selected types.',
		inMinutes: (minutes: number) => `in ${minutes} min`,
		events: { '0': 'Outage starts', '1': 'Power expected back' },
		added: (status: string, range: string) => `Added · ${status} · ${range}`,
		removed: (status: string, range: string) => `Removed · ${status} · ${range}`,
		moved: (status: string, before: string, after: string) => `${status} moved from ${before} to ${after}`,
		welcome:
			'<b>Welcome!</b> I track scheduled power outages in Chernivtsi. Use the buttons to turn alerts on or off.\n\n<b>Commands</b>\n<b>/status</b> — current status and published schedule\n<b>/language</b> — choose your language\n<b>/subscribe</b> — receive alerts\n<b>/unsubscribe</b> — stop alerts\n<b>/help</b> — show this guide',
		language: '<b>Choose your language</b>',
		saved: '<b>English selected</b>',
		unavailable: 'No current schedule could be verified.',
		initial: '<b>First published schedule</b>',
		updated: '<b>Schedule updated</b>',
		nowShort: 'NOW',
		nextShort: 'NEXT',
		nextStatus: { '0': 'Outage', '1': 'Power expected', '3': 'Supply uncertain' },
		outageLabels: { '0': 'Outage', '3': 'Supply uncertain' },
		noOutages: 'No outages scheduled.',
		noRemainingOutages: 'No more outages scheduled for today.',
		status: { '0': 'Outage expected', '1': 'Power expected', '3': 'Supply uncertain' },
		languageButton: 'Language',
		subscribeButton: 'Receive alerts',
		unsubscribeButton: 'Stop alerts',
		subscribed: '<b>Alerts are on</b>\nChoose what to receive in Alert settings.',
		unsubscribed: '<b>Alerts are off</b>\nYou can still check the schedule with /status.',
	},
	uk: {
		title: (group: string) => `Чернівці · Група ${group}`,
		localTime: 'Місцевий час',
		reminderTime: 'Київський час',
		todayButton: 'Сьогодні',
		alertsButton: 'Налаштування сповіщень',
		backButton: 'Назад',
		alertLabels: { updates: 'Зміни графіка', cutoff: 'Нагадування про відключення', return: 'Нагадування про відновлення' },
		leadTime: (minutes: number) => `За ${minutes} хв`,
		alertSettings: '<b>Налаштування сповіщень</b>\nОберіть, які сповіщення отримувати.',
		alertsPaused: 'Усі сповіщення призупинено. Увімкніть їх, щоб отримувати вибрані типи.',
		inMinutes: (minutes: number) => `через ${minutes} хв`,
		events: { '0': 'Початок відключення', '1': 'Очікуване відновлення живлення' },
		added: (status: string, range: string) => `Додано · ${status} · ${range}`,
		removed: (status: string, range: string) => `Скасовано · ${status} · ${range}`,
		moved: (status: string, before: string, after: string) => `${status} перенесено з ${before} на ${after}`,
		welcome:
			'<b>Вітаю!</b> Я відстежую графік відключень електроенергії в Чернівцях. Сповіщення можна увімкнути або вимкнути кнопками.\n\n<b>Команди</b>\n<b>/status</b> — поточний стан і графік\n<b>/language</b> — вибрати мову\n<b>/subscribe</b> — увімкнути сповіщення\n<b>/unsubscribe</b> — вимкнути сповіщення\n<b>/help</b> — показати довідку',
		language: '<b>Оберіть мову</b>',
		saved: '<b>Обрано українську мову</b>',
		unavailable: 'Актуальний графік наразі недоступний або його не вдалося перевірити.',
		initial: '<b>Перший опублікований графік</b>',
		updated: '<b>Графік оновлено</b>',
		nowShort: 'ЗАРАЗ',
		nextShort: 'ДАЛІ',
		nextStatus: { '0': 'Відключення', '1': 'Очікується електропостачання', '3': 'Електропостачання невизначене' },
		outageLabels: { '0': 'Відключення', '3': 'Електропостачання невизначене' },
		noOutages: 'Відключень не заплановано.',
		noRemainingOutages: 'На сьогодні більше відключень не заплановано.',
		status: { '0': 'Очікується відключення', '1': 'Очікується електропостачання', '3': 'Електропостачання невизначене' },
		languageButton: 'Мова',
		subscribeButton: 'Отримувати сповіщення',
		unsubscribeButton: 'Вимкнути сповіщення',
		subscribed: '<b>Сповіщення увімкнено</b>\nОберіть потрібні типи в налаштуваннях сповіщень.',
		unsubscribed: '<b>Сповіщення вимкнено</b>\nВи й надалі можете переглядати графік за допомогою /status.',
	},
};

type AlertKind = keyof typeof messages.en.alertLabels;
const reminderOptions = [5, 15, 30] as const;
export type AlertPreferences = Record<AlertKind, boolean> & { minutes: (typeof reminderOptions)[number] };
export const defaultAlerts: AlertPreferences = { updates: true, cutoff: true, return: true, minutes: 15 };
const alertKinds = Object.keys(messages.en.alertLabels) as AlertKind[];

export function alertMenu(language: Language, preferences: AlertPreferences) {
	const copy = messages[language];
	return {
		keyboard: [
			...alertKinds.map((kind) => [{ text: (preferences[kind] ? '✓ ' : '○ ') + copy.alertLabels[kind] }]),
			reminderOptions.map((minutes) => ({ text: (preferences.minutes === minutes ? '✓ ' : '') + copy.leadTime(minutes) })),
			[{ text: copy.backButton }],
		],
		resize_keyboard: true,
	};
}

export function formatMessage(group: string, language: Language, ...sections: string[]): string {
	const header = `<b>${messages[language].title(group)}</b>\n────────────────────`;
	return [header, ...sections].join('\n\n');
}

export function menu(language: Language, subscribed: boolean) {
	const copy = messages[language];
	return {
		keyboard: [
			[{ text: copy.todayButton }],
			[{ text: copy.alertsButton }, { text: copy.languageButton }],
			[{ text: subscribed ? copy.unsubscribeButton : copy.subscribeButton }],
		],
		resize_keyboard: true,
	};
}

export const languageMenu = {
	keyboard: [[{ text: 'Українська' }, { text: 'English' }]],
	resize_keyboard: true,
	one_time_keyboard: true,
};

export function parseCommand(text: string) {
	const input = text.trim().toLowerCase();
	const command = input.startsWith('/') ? input.split(/[\s@]/, 1)[0] : input;
	const label = command.replace(/^[✓○] /u, '');
	for (const copy of Object.values(messages)) {
		const minutes = reminderOptions.find((option) => label === copy.leadTime(option).toLowerCase());
		if (minutes) return { type: 'leadTime' as const, minutes };
		for (const kind of alertKinds) {
			if (label === copy.alertLabels[kind].toLowerCase()) {
				return { type: 'alertKind' as const, kind, enabled: !command.startsWith('✓ ') };
			}
		}
	}
	switch (command) {
		case '/today':
		case 'today':
		case 'сьогодні':
		case 'hoy':
			return 'status';
		case '/alerts':
		case 'alert settings':
		case 'налаштування сповіщень':
			return 'alerts';
		case 'back':
		case 'назад':
			return 'back';
		case '/start':
		case '/help':
			return 'help';
		case '/subscribe':
		case 'receive alerts':
		case 'отримувати сповіщення':
			return 'subscribe';
		case '/unsubscribe':
		case 'stop alerts':
		case 'вимкнути сповіщення':
			return 'unsubscribe';
		case '/status':
		case '/estado':
		case 'power status':
		case 'стан живлення':
		case '⚡ power status':
		case '⚡ стан живлення':
			return 'status';
		case '/language':
		case 'language':
		case 'idioma':
		case 'мова':
		case '🌐 language':
		case '🌐 мова':
			return 'language';
		case '/uk':
		case 'українська':
		case '🇺🇦 українська':
			return 'uk';
		case '/en':
		case 'english':
		case '🇬🇧 english':
			return 'en';
	}
}
