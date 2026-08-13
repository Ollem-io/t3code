import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
//#region apps/server/src/provider/prime/PrimeResourceLayout.ts
const MAX_ID_LENGTH$1 = 512;
/** A path segment made from a complete UTF-8 identifier, never caller path syntax. */
const primePathComponent = (value) => {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH$1 || value === "." || value === "..") throw new Error("Prime resource IDs must be non-empty bounded values, not dot components");
	return `id-${Buffer.from(value, "utf8").toString("base64url")}`;
};
const decodePrimePathComponent = (value) => {
	if (!value.startsWith("id-") || value.length === 3) return void 0;
	try {
		const decoded = Buffer.from(value.slice(3), "base64url").toString("utf8");
		return primePathComponent(decoded) === value ? decoded : void 0;
	} catch {
		return;
	}
};
const assertPrimeContained = (root, path) => {
	const segment = relative(resolve(root), resolve(path));
	if (segment === "" || segment === ".." || segment.startsWith(`..${sep}`) || isAbsolute(segment)) throw new Error("Prime resource path escaped its T3 home namespace");
};
const primeResourceLayout = (input) => {
	const root = join(resolve(input.home), "userdata", "prime", "v1");
	const environment = join(root, "environments", primePathComponent(input.environmentId));
	const instance = join(environment, "instances", primePathComponent(input.instanceId));
	const thread = join(instance, "threads", primePathComponent(input.threadId));
	const ownershipDirectory = join(instance, "ownership");
	const result = {
		root,
		environment,
		instance,
		thread,
		session: join(thread, "session"),
		config: join(thread, "config.json"),
		daemon: join(instance, "daemon"),
		ownershipDirectory,
		ownership: join(ownershipDirectory, `${primePathComponent(input.threadId)}.json`),
		daemonOwnership: join(ownershipDirectory, "daemon.json")
	};
	for (const path of Object.values(result).slice(1)) assertPrimeContained(root, path);
	return result;
};
//#endregion
//#region apps/server/src/provider/prime/PrimeOwnership.ts
const MAX_ID_LENGTH = 512;
const validId = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const exact = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
function isRecord(v) {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const r = v;
	if (!exact(r, [
		"version",
		"environmentId",
		"instanceId",
		"threadId",
		"kind",
		"phase",
		"process",
		"rpcSessionId",
		"daemonSessionId"
	]) || r.version !== 1 || !validId(r.environmentId) || !validId(r.instanceId) || !validId(r.threadId)) return false;
	if (r.kind !== void 0 && r.kind !== "thread" && r.kind !== "daemon") return false;
	if (r.phase !== void 0 && ![
		"active",
		"stopping",
		"stopped",
		"sessions-cleaned",
		"resources-cleaned"
	].includes(r.phase)) return false;
	if (r.process !== void 0) {
		if (!r.process || typeof r.process !== "object" || Array.isArray(r.process)) return false;
		const p = r.process;
		if (!exact(p, ["pid", "startToken"]) || !Number.isSafeInteger(p.pid) || p.pid <= 0 || !validId(p.startToken)) return false;
	}
	return (r.rpcSessionId === void 0 || validId(r.rpcSessionId)) && (r.daemonSessionId === void 0 || validId(r.daemonSessionId));
}
const identify = (path) => {
	const a = resolve(path).split(sep);
	const n = a.length;
	const file = basename(path).replace(/\.cleaning$/, "");
	if (!file.endsWith(".json")) return;
	const oi = a.lastIndexOf("ownership");
	if (oi < 7 || oi !== n - 2 || a[oi - 1]?.startsWith("id-") !== true || a[oi - 2] !== "instances" || a[oi - 3]?.startsWith("id-") !== true || a[oi - 4] !== "environments" || a[oi - 5] !== "v1" || a[oi - 6] !== "prime" || a[oi - 7] !== "userdata") return;
	const environmentId = decodePrimePathComponent(a[oi - 3]);
	const instanceId = decodePrimePathComponent(a[oi - 1]);
	const threadId = file === "daemon.json" ? "__daemon__" : decodePrimePathComponent(file.slice(0, -5));
	if (!environmentId || !instanceId || !threadId) return;
	const root = a.slice(0, oi - 4).join(sep) || sep;
	const instance = a.slice(0, oi).join(sep) || sep;
	return {
		root,
		environmentId,
		instanceId,
		threadId,
		instance,
		thread: join(instance, "threads", primePathComponent(threadId)),
		daemon: join(instance, "daemon")
	};
};
const syncDir = (p) => {
	try {
		const fd = openSync(p, constants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {}
};
const atomicWrite = async (path, record) => {
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const h = await open(temp, "wx", 384);
	try {
		await h.writeFile(`${JSON.stringify(record)}\n`);
		await h.sync();
	} finally {
		await h.close();
	}
	try {
		await rename(temp, path);
		syncDir(dirname(path));
	} finally {
		await rm(temp, { force: true }).catch(() => void 0);
	}
};
const safeParents = async (path, id) => {
	const rel = relative(id.root, dirname(path));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("ownership path is outside Prime root");
	await mkdir(id.root, {
		recursive: true,
		mode: 448
	});
	let cur = id.root;
	const rootStat = await lstat(cur);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Prime root is not a real directory");
	for (const part of rel.split(sep)) {
		cur = join(cur, part);
		try {
			const s = await lstat(cur);
			if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Prime ownership parent is not a real directory");
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
			try {
				await mkdir(cur, { mode: 448 });
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
			const made = await lstat(cur);
			if (!made.isDirectory() || made.isSymbolicLink()) throw new Error("Prime ownership parent is not a real directory");
		}
	}
};
/** Durable atomic persistence into a per-thread record; no concurrent thread can overwrite another. */
const writePrimeOwnership = async (path, record) => {
	const id = identify(path);
	if (!id || !isRecord(record) || record.environmentId !== id.environmentId || record.instanceId !== id.instanceId || record.threadId !== id.threadId || basename(path) === "daemon.json" !== (record.kind === "daemon") || (record.kind === "daemon" ? record.rpcSessionId !== void 0 : record.daemonSessionId !== void 0)) throw new Error("invalid or path-mismatched Prime ownership record");
	await safeParents(path, id);
	try {
		const s = await lstat(path);
		if (s.isSymbolicLink() || !s.isFile()) throw new Error("ownership target is not a regular file");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	await atomicWrite(path, {
		...record,
		phase: record.phase ?? "active"
	});
};
const decode = (text) => {
	try {
		const v = JSON.parse(text);
		if (v && typeof v === "object" && !Array.isArray(v) && typeof v.version === "number" && v.version > 1) return { reason: "future ownership record version; left intact" };
		return isRecord(v) ? { record: v } : { reason: "partial, corrupt, or unsupported ownership record; left intact" };
	} catch {
		return { reason: "partial or corrupt ownership record; left intact" };
	}
};
const warning = (path, reason) => ({
	kind: "warning",
	warning: {
		path,
		reason
	}
});
const removeExact = async (path, actions) => {
	try {
		const s = await lstat(path);
		if (s.isSymbolicLink()) throw new Error("refusing to follow resource symlink");
		await rm(path, {
			recursive: s.isDirectory(),
			force: true
		});
		actions.push({
			kind: "resource-removed",
			path
		});
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
};
const cleanupPrimeOwnership = async (path, proof, cleanup) => {
	const id = identify(path);
	if (!id) throw new Error("ownership path is outside exact Prime layout");
	const actions = [];
	const claim = `${path}.cleaning`;
	try {
		await rename(path, claim);
	} catch (e) {
		if (e.code === "ENOENT") return actions;
		return [warning(path, "ownership record could not be claimed; left intact")];
	}
	let retain = true;
	try {
		const s = await lstat(claim);
		if (!s.isFile() || s.isSymbolicLink()) throw new Error("claimed ownership record is not a regular file");
		const d = decode(await readFile(claim, "utf8"));
		if (!d.record) {
			actions.push(warning(path, d.reason));
			return actions;
		}
		let r = d.record;
		if (r.environmentId !== id.environmentId || r.instanceId !== id.instanceId || r.threadId !== id.threadId || basename(path) === "daemon.json" !== (r.kind === "daemon") || (r.kind === "daemon" ? r.rpcSessionId !== void 0 : r.daemonSessionId !== void 0)) {
			actions.push(warning(path, "ownership identity does not match its exact layout path; left intact"));
			return actions;
		}
		let phase = r.phase ?? "active";
		if (phase === "stopping") {
			actions.push(warning(path, "process stop outcome is ambiguous; retained for manual recovery"));
			return actions;
		}
		if (phase === "active" && r.process) {
			const process = r.process;
			let matched = false;
			try {
				matched = await proof.processMatches(process);
			} catch (e) {
				actions.push(warning(path, `process proof threw: ${String(e)}`));
				return actions;
			}
			if (!matched) {
				actions.push(warning(path, "captured process PID/start token cannot be proven; left intact"));
				return actions;
			}
			r = {
				...r,
				phase: "stopping"
			};
			await atomicWrite(claim, r);
			actions.push({
				kind: "process-stopping",
				path
			});
			try {
				await cleanup.stopProcess(process);
			} catch (e) {
				actions.push(warning(path, `process stop threw after durable stopping transition: ${String(e)}`));
				return actions;
			}
			r = {
				...r,
				phase: "stopped"
			};
			await atomicWrite(claim, r);
			phase = "stopped";
			actions.push({
				kind: "process-stopped",
				path
			});
		} else if (phase === "active") {
			r = {
				...r,
				phase: "stopped"
			};
			await atomicWrite(claim, r);
			phase = "stopped";
		}
		if (phase === "stopped") {
			for (const [name, value, match, fn, kind] of [[
				"RPC",
				r.rpcSessionId,
				proof.rpcSessionMatches,
				cleanup.cleanupRpcSession,
				"rpc-session-cleaned"
			], [
				"daemon",
				r.daemonSessionId,
				proof.daemonSessionMatches,
				cleanup.cleanupDaemonSession,
				"daemon-session-cleaned"
			]]) if (value) {
				let ok = false;
				try {
					ok = await match?.(value) ?? false;
				} catch (e) {
					actions.push(warning(path, `${name} proof threw: ${String(e)}`));
					return actions;
				}
				if (!ok) {
					actions.push(warning(path, `${name} identity cannot be proven; left intact`));
					return actions;
				}
				try {
					await fn?.(value);
					if (!fn) throw new Error("cleanup callback missing");
					actions.push({
						kind,
						path
					});
				} catch (e) {
					actions.push(warning(path, `${name} cleanup threw: ${String(e)}`));
					return actions;
				}
			}
			r = {
				...r,
				phase: "sessions-cleaned"
			};
			await atomicWrite(claim, r);
			phase = "sessions-cleaned";
		}
		if (phase === "sessions-cleaned") {
			try {
				if ((r.kind ?? "thread") === "daemon") await removeExact(id.daemon, actions);
				else {
					await removeExact(join(id.thread, "session"), actions);
					await removeExact(join(id.thread, "config.json"), actions);
					await removeExact(id.thread, actions);
				}
			} catch (e) {
				actions.push(warning(path, `exact resource cleanup failed: ${String(e)}`));
				return actions;
			}
			r = {
				...r,
				phase: "resources-cleaned"
			};
			await atomicWrite(claim, r);
		}
		try {
			await rm(claim);
			syncDir(dirname(claim));
			retain = false;
			actions.push({
				kind: "record-removed",
				path
			});
		} catch (e) {
			actions.push(warning(path, `record removal failed after cleanup: ${String(e)}`));
		}
		return actions;
	} catch (e) {
		actions.push(warning(path, `cleanup failed: ${String(e)}`));
		return actions;
	} finally {
		if (retain) try {
			await rename(claim, path);
		} catch (e) {
			actions.push(warning(path, `could not restore claimed record: ${String(e)}`));
		}
	}
};
const recoverPrimeOwnership = async (root, proof, cleanup) => {
	const expected = resolve(root);
	if (basename(expected) !== "v1" || basename(dirname(expected)) !== "prime" || basename(dirname(dirname(expected))) !== "userdata") throw new Error("recovery root is not exact Prime layout");
	const actions = [];
	const visit = async (dir) => {
		try {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isSymbolicLink()) continue;
				if (e.isDirectory()) await visit(p);
				else if (e.isFile() && e.name.endsWith(".json") && identify(p)?.root === expected) try {
					actions.push(...await cleanupPrimeOwnership(p, proof, cleanup));
				} catch (error) {
					actions.push(warning(p, `record cleanup threw: ${String(error)}`));
				}
				else if (e.isFile() && e.name.endsWith(".json.cleaning") && identify(p)?.root === expected) try {
					await rename(p, p.slice(0, -9));
					actions.push(warning(p, "recovered interrupted cleanup claim"));
				} catch (error) {
					actions.push(warning(p, `claim recovery failed: ${String(error)}`));
				}
				else if (e.isFile() && e.name.includes(".tmp")) actions.push(warning(p, "incomplete atomic write retained for inspection"));
			}
		} catch (error) {
			if (error.code !== "ENOENT") actions.push(warning(dir, `ownership directory unreadable: ${String(error)}`));
		}
	};
	await visit(expected);
	return actions;
};
//#endregion
//#region apps/server/src/provider/prime/verify-prime-ownership.ts
function check(v, m) {
	if (!v) throw Error(m);
}
const homes = [await mkdtemp(join(tmpdir(), "t3-pa-m06-a-")), await mkdtemp(join(tmpdir(), "t3-pa-m06-b-"))];
try {
	const a = primeResourceLayout({
		home: homes[0],
		environmentId: "env",
		instanceId: "one",
		threadId: "a"
	});
	const sibling = primeResourceLayout({
		home: homes[0],
		environmentId: "env",
		instanceId: "one",
		threadId: "b"
	});
	const other = primeResourceLayout({
		home: homes[1],
		environmentId: "env",
		instanceId: "two",
		threadId: "a"
	});
	const record = (instanceId, threadId, pid) => ({
		version: 1,
		environmentId: "env",
		instanceId,
		threadId,
		process: {
			pid,
			startToken: `start-${pid}`
		},
		rpcSessionId: `rpc-${threadId}`
	});
	await Promise.all([
		writePrimeOwnership(a.ownership, record("one", "a", 1)),
		writePrimeOwnership(sibling.ownership, record("one", "b", 2)),
		writePrimeOwnership(other.ownership, record("two", "a", 3))
	]);
	await mkdir(a.session, { recursive: true });
	await writeFile(a.config, "config");
	const sentinel = join(homes[0], "sentinel");
	await writeFile(sentinel, "safe");
	const calls = [];
	await cleanupPrimeOwnership(a.ownership, {
		processMatches: async (h) => h.pid === 1 && h.startToken === "start-1",
		rpcSessionMatches: async (id) => id === "rpc-a"
	}, {
		stopProcess: async (h) => {
			calls.push(`stop:${h.pid}`);
		},
		cleanupRpcSession: async (id) => {
			calls.push(`rpc:${id}`);
		}
	});
	check(calls.join() === "stop:1,rpc:rpc-a", "callbacks must be exact");
	await stat(sibling.ownership);
	await stat(other.ownership);
	check(await readFile(sentinel, "utf8") === "safe", "sentinel changed");
	const bad = primeResourceLayout({
		home: homes[0],
		environmentId: "env",
		instanceId: "bad",
		threadId: "x"
	});
	await mkdir(bad.ownershipDirectory, { recursive: true });
	await writeFile(bad.ownership, "{");
	check((await recoverPrimeOwnership(a.root, { processMatches: async () => false }, { stopProcess: async () => {
		throw Error("must not stop");
	} })).some((x) => x.kind === "warning"), "corrupt record must warn");
	process.stdout.write("Prime ownership review artifact passed\n");
} finally {
	await Promise.all(homes.map((h) => rm(h, {
		recursive: true,
		force: true
	})));
}
//#endregion
export {};
