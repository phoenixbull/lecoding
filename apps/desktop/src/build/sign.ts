/**
 * Code signing & notarization pipeline.
 *
 * Builds the structured plans that the desktop build script feeds to
 * signtool (Windows) and codesign + notarytool (macOS). The functions
 * here never invoke the tools themselves — that's the CI script's job.
 * Keeping this layer pure means tests can pin the exact arguments without
 * spawning subprocesses.
 *
 * PRD § 10.1: Windows + macOS installers must be code-signed and macOS
 * installers must also be notarized. The plan enforces both steps in
 * order so a misconfigured run fails before files reach the registry.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SigningEnvironmentLike {
  CSC_LINK?: string;
  CSC_KEY_PASSWORD?: string;
  APPLE_ID?: string;
  APPLE_APP_SPECIFIC_PASSWORD?: string;
  APPLE_TEAM_ID?: string;
}

export interface SigningPlan {
  signingEnabled: boolean;
  certificateFile?: string;
  certificatePassword?: string;
  appleId?: string;
  appleAppSpecificPassword?: string;
  appleTeamId?: string;
}

export function parseSigningEnvironment(env: SigningEnvironmentLike): SigningPlan {
  const plan: SigningPlan = { signingEnabled: false };
  if (env.CSC_LINK) {
    if (!env.CSC_KEY_PASSWORD) {
      throw new Error("sign: cert password (CSC_KEY_PASSWORD) must be set whenever CSC_LINK is present");
    }
    const certificateFile = decodeCertificate(env.CSC_LINK, { writeToTempFile: true });
    plan.signingEnabled = true;
    plan.certificateFile = certificateFile;
    plan.certificatePassword = env.CSC_KEY_PASSWORD;
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    plan.signingEnabled = true;
    plan.appleId = env.APPLE_ID;
    plan.appleAppSpecificPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
    plan.appleTeamId = env.APPLE_TEAM_ID;
  }
  return plan;
}

export interface DecodeOptions {
  writeToTempFile?: boolean;
}

/**
 * Decode a base64-encoded .p12. By default returns the raw bytes; with
  `writeToTempFile: true` decodes to a freshly-minted .p12 in the OS temp
  directory so electron-forge can read it from disk.
 */
export function decodeCertificate(value: string, options: DecodeOptions = {}): string {
  // Be strict: refuse anything that isn't strictly base64 (no whitespace,
  // no URL-safe alphabet drift). electron-forge and codesign both reject
  // quietly when given malformed certs, so we surface the failure here.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("sign: certificate is not strict base64");
  }
  const buffer = Buffer.from(value, "base64");
  if (!options.writeToTempFile) {
    // Return a non-path sentinel so callers can detect the "no file" branch.
    return buffer.toString("binary");
  }
  const directory = mkdtempSync(join(tmpdir(), "lecoding-cert-"));
  const filePath = join(directory, "certificate.p12");
  writeFileSync(filePath, buffer);
  return filePath;
}

export interface WindowsSignInputs {
  certificateFile: string;
  certificatePassword: string;
  artifact: string;
}

export interface SignToolInvocation {
  command: string;
  args: string[];
}

/**
 * Build the signtool.exe command line for an installer. The args are
 * pinned so any future change to the algorithm (e.g. SHA-1) must be
 * reflected in this function and re-reviewed.
 */
export function buildWindowsSignToolInvocation(
  inputs: WindowsSignInputs
): SignToolInvocation {
  return {
    command: "signtool.exe",
    args: [
      "sign",
      "/fd",
      "sha256",
      "/td",
      "sha256",
      "/tr",
      "http://timestamp.digicert.com",
      "/f",
      inputs.certificateFile,
      "/p",
      inputs.certificatePassword,
      inputs.artifact
    ]
  };
}

export interface MacosPlanInputs {
  appleId: string;
  appleAppSpecificPassword: string;
  appleTeamId: string;
  artifact: string;
}

export interface PlanStep {
  command: string;
  args: string[];
}

export interface MacosNotarizationPlan {
  steps: PlanStep[];
}

/**
 * Build a two-step macOS plan: codesign the artifact, then notarize via
 * notarytool. Order matters — notarization requires the artifact to be
 * signed first; reversing the steps produces an obvious runtime error
 * from notarytool rather than a silent failure.
 */
export function buildMacosNotarizationPlan(inputs: MacosPlanInputs): MacosNotarizationPlan {
  if (!inputs.appleTeamId) {
    throw new Error("sign: notarization requires a non-empty Apple team id");
  }
  return {
    steps: [
      {
        command: "codesign",
        args: [
          "--force",
          "--deep",
          "--options",
          "runtime",
          "--timestamp",
          "--sign",
          "Developer ID Application: LeCoding",
          inputs.artifact
        ]
      },
      {
        command: "xcrun",
        args: [
          "notarytool",
          "submit",
          inputs.artifact,
          "--apple-id",
          inputs.appleId,
          "--password",
          inputs.appleAppSpecificPassword,
          "--team-id",
          inputs.appleTeamId,
          "--wait"
        ]
      }
    ]
  };
}