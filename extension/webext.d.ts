// The handful of WebExtension calls the extension makes, hand-written rather
// than a types package: the surface is small and it keeps the toolchain as is.

interface WebExtTab {
	id?: number;
	url?: string;
	title?: string;
}

interface WebExtSender {
	id?: string;
	url?: string;
	tab?: WebExtTab;
}

interface WebExtEvent<Listener> {
	addListener(listener: Listener): void;
	removeListener(listener: Listener): void;
}

interface WebExtStorageChange {
	oldValue?: unknown;
	newValue?: unknown;
}

interface WebExtApi {
	runtime: {
		id: string;
		sendMessage(message: unknown): Promise<unknown>;
		onMessage: WebExtEvent<
			(
				message: unknown,
				sender: WebExtSender,
				sendResponse: (response: unknown) => void
			) => boolean | void
		>;
	};
	storage: {
		local: {
			get(keys: string | string[]): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		onChanged: WebExtEvent<(changes: Record<string, WebExtStorageChange>, area: string) => void>;
	};
	tabs: {
		query(query: { url?: string[] }): Promise<WebExtTab[]>;
		sendMessage(tabId: number, message: unknown): Promise<unknown>;
	};
	action: {
		onClicked: WebExtEvent<(tab: WebExtTab) => void>;
	};
	scripting: {
		executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
		insertCSS(details: { target: { tabId: number }; files: string[] }): Promise<void>;
	};
}

declare var browser: WebExtApi | undefined;
declare var chrome: WebExtApi | undefined;

/** The app's origins, baked in by `extension/vite.config.ts`. */
declare const __SAPLING_ORIGINS__: string[];
