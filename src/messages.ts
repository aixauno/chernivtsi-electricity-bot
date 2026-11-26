export type Language = "en" | "uk";

export const messages = {
	en: {
		title: (group: string) => `Chernivtsi · Group ${group}`,
		localTime: "Local time",
		welcome: "<b>Welcome!</b> I track scheduled power outages in Chernivtsi. Use the buttons to turn alerts on or off.\n\n<b>Commands</b>\n/status — current status and published schedule\n/language — choose your language\n/subscribe — receive alerts\n/unsubscribe — stop alerts\n/help — show this guide",
		language: "<b>Choose your language</b>",
		saved: "<b>English selected</b>",
		unavailable: "No current schedule could be verified.",
		published: "The operator published today’s schedule. I couldn’t verify the time slots for your group.",
		officialPost: "View the official schedule",
		initial: "<b>First published schedule</b>",
		updated: "<b>Schedule updated</b>",
		now: "Current status",
		next: "Next scheduled change",
		nowShort: "NOW",
		nextShort: "NEXT",
		nextStatus: { "0": "Outage", "1": "Power expected", "3": "Supply uncertain" },
		noOutages: "No outages scheduled.",
		status: { "0": "Outage expected", "1": "Power expected", "3": "Supply uncertain" },
		statusButton: "Power status",
		languageButton: "Language",
		subscribeButton: "Receive alerts",
		unsubscribeButton: "Stop alerts",
		subscribed: "<b>Alerts are on</b>\nYou’ll get a message when the schedule for your group is published or updated, when the expected supply status changes, and shortly before the next scheduled change.",
		unsubscribed: "<b>Alerts are off</b>\nYou can still check the schedule with /status.",
	},
	uk: {
		title: (group: string) => `Чернівці · Група ${group}`,
		localTime: "Місцевий час",
		welcome: "<b>Вітаю!</b> Я відстежую графік відключень електроенергії в Чернівцях. Сповіщення можна увімкнути або вимкнути кнопками.\n\n<b>Команди</b>\n/status — поточний стан і графік\n/language — вибрати мову\n/subscribe — увімкнути сповіщення\n/unsubscribe — вимкнути сповіщення\n/help — показати довідку",
		language: "<b>Оберіть мову</b>",
		saved: "<b>Обрано українську мову</b>",
		unavailable: "Актуальний графік наразі недоступний або його не вдалося перевірити.",
		published: "Оператор опублікував графік на сьогодні. Не вдалося перевірити години для вашої групи.",
		officialPost: "Переглянути офіційний графік",
		initial: "<b>Перший опублікований графік</b>",
		updated: "<b>Графік оновлено</b>",
		now: "Поточний стан",
		next: "Наступна зміна за графіком",
		nowShort: "ЗАРАЗ",
		nextShort: "ДАЛІ",
		nextStatus: { "0": "Відключення", "1": "Очікується електропостачання", "3": "Електропостачання невизначене" },
		noOutages: "Відключень не заплановано.",
		status: { "0": "Очікується відключення", "1": "Очікується електропостачання", "3": "Електропостачання невизначене" },
		statusButton: "Стан живлення",
		languageButton: "Мова",
		subscribeButton: "Отримувати сповіщення",
		unsubscribeButton: "Вимкнути сповіщення",
		subscribed: "<b>Сповіщення увімкнено</b>\nВи отримаєте повідомлення, коли графік вашої групи опублікують або оновлять, коли зміниться очікуваний стан живлення та незадовго до наступної зміни за графіком.",
		unsubscribed: "<b>Сповіщення вимкнено</b>\nВи й надалі можете переглядати графік за допомогою /status.",
	},
};

export function messageHeader(group: string, language: Language): string {
	return `<b>${messages[language].title(group)}</b>\n────────────────────`;
}

export function menu(language: Language, subscribed: boolean) {
	const copy = messages[language];
	return {
		keyboard: [
			[{ text: copy.statusButton }, { text: copy.languageButton }],
			[{ text: subscribed ? copy.unsubscribeButton : copy.subscribeButton }],
		],
		resize_keyboard: true,
	};
}

export const languageMenu = {
	keyboard: [[{ text: "Українська" }, { text: "English" }]],
	resize_keyboard: true,
	one_time_keyboard: true,
};

export function parseCommand(text: string) {
	const input = text.trim().toLowerCase();
	const command = input.startsWith("/") ? input.split(/[\s@]/, 1)[0] : input;
	switch (command) {
		case "/start":
		case "/help": return "help";
		case "/subscribe":
		case "receive alerts":
		case "отримувати сповіщення": return "subscribe";
		case "/unsubscribe":
		case "stop alerts":
		case "вимкнути сповіщення": return "unsubscribe";
		case "/status":
		case "/estado":
		case "power status":
		case "стан живлення":
		case "⚡ power status":
		case "⚡ стан живлення": return "status";
		case "/language":
		case "language":
		case "idioma":
		case "мова":
		case "🌐 language":
		case "🌐 мова": return "language";
		case "/uk":
		case "українська":
		case "🇺🇦 українська": return "uk";
		case "/en":
		case "english":
		case "🇬🇧 english": return "en";
	}
}
