// Single source of truth for the CLI version string. Kept in its own module so
// scripts/build-bin.sh can sed-patch it from package.json during a release
// build (source trees already match package.json; the patch is idempotent).
export const CLI_VERSION = "0.2.1";
