// The one place the tool's own version is read. Every producer (the capture header, and through it every report and
// export) asks `toolVersion()`; nothing writes a version string of its own.
//
// The value comes from package.json, injected at build time:
//   - the command line bundle (scripts/build-cli.mjs) defines `__VERSION__`;
//   - the app (vite.config.ts, and vitest.config.ts for the unit tests) defines `__APP_VERSION__`.
// Both read the root package.json, so there is one version to bump. 'dev' is only the answer when neither is defined
// (running the source without a bundler).

declare const __VERSION__: string | undefined
declare const __APP_VERSION__: string | undefined

/** What `toolVersion()` decides, with the two build-time values passed in so the fallback can be tested. */
export function resolveToolVersion(cli: string | undefined, app: string | undefined): string {
    return cli || app || 'dev'
}

export const toolVersion = (): string =>
    resolveToolVersion(typeof __VERSION__ === 'undefined' ? undefined : __VERSION__, typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__)
