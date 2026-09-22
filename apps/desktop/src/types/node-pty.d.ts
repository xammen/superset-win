/**
 * `node-pty` is aliased to `@lydell/node-pty` (see `apps/desktop/package.json`)
 * so Windows gets prebuilt ConPTY binaries without VS Build Tools.
 *
 * The aliased package ships a typings file that declares its *own* module name
 * (`declare module "@lydell/node-pty"`), which TypeScript cannot associate with
 * imports written as `"node-pty"` — it reports TS2306 "is not a module".
 *
 * This shim re-declares the name our sources import, re-exporting the real
 * types from `@lydell/node-pty` (declared as a direct dependency so the
 * module name resolves).
 */
declare module "node-pty" {
	export * from "@lydell/node-pty";
}
