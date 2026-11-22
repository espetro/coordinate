import { setup, type Registry } from "rivetkit";
import { session } from "./session.js";

export const registry: Registry<{ session: typeof session }> = setup({
	use: { session },
});
