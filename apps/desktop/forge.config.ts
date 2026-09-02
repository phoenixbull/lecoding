/**
 * electron-forge CLI entry point.
 *
 * The CLI expects `module.exports = config` (or an ESM default export).
 * The pure builder in `./src/build/forge-config.ts` produces the config
 * without any electron-forge runtime import, so the same inputs flow
 * through CI scripts, tests, and developer machines identically.
 */

import {
  buildForgeConfig,
  resolveReleaseVersion,
  type ForgeConfigInputs,
  type SigningEnvironment
} from "./src/build/forge-config.js";

function readSigningEnvironment(): SigningEnvironment {
  // `process.env` is treated as the only source of truth so CI and local
  // builds behave the same way. Each credential is required only when
  // the matching platform is being built.
  const out: SigningEnvironment = {};
  if (process.env["CSC_LINK"]) out.CSC_LINK = process.env["CSC_LINK"];
  if (process.env["CSC_KEY_PASSWORD"]) {
    out.CSC_KEY_PASSWORD = process.env["CSC_KEY_PASSWORD"];
  }
  if (process.env["APPLE_ID"]) out.APPLE_ID = process.env["APPLE_ID"];
  if (process.env["APPLE_APP_SPECIFIC_PASSWORD"]) {
    out.APPLE_APP_SPECIFIC_PASSWORD = process.env["APPLE_APP_SPECIFIC_PASSWORD"];
  }
  if (process.env["APPLE_TEAM_ID"]) out.APPLE_TEAM_ID = process.env["APPLE_TEAM_ID"];
  return out;
}

const inputs: ForgeConfigInputs = {
  appName: "LeCoding",
  appVersion: resolveReleaseVersion({
    releaseTag: process.env["LECODING_RELEASE_VERSION"],
    packageVersion: process.env["npm_package_version"]
  }),
  rendererEntry: "../renderer/dist/index.html",
  mainEntry: "./src/main/index.ts",
  preloadEntry: "./src/preload/index.ts",
  signEnv: readSigningEnvironment(),
  repository: process.env["LECODING_GITHUB_REPOSITORY"] ?? "phoenixbull/lecoding"
};

const config = buildForgeConfig(inputs);

export default config;
