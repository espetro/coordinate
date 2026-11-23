#!/usr/bin/env bun
// Queue-scenario server: the density/wake session actor plus the coordinator.
import { setup } from "rivetkit";
import { session } from "./session.js";
import { coordinator } from "./queue.js";

export const registry = setup({
	use: { session, coordinator },
});

registry.start();
