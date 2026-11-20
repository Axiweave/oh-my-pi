/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Protocol hosts never get the inbox tool (it needs the TUI transcript), so they keep the default.
export const cfgInboxEnabled = register({
	id: "inbox.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Session Inbox",
		label: "Session Inbox",
		description:
			"Let other local omp sessions of this user list this session, send it requests or notifications, and interrupt it (session_inbox tool)",
	},
});
