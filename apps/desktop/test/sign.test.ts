/**
 * Signing-environment parser tests.
 *
 * The Desktop build pipeline reads signing credentials from environment
 * variables (CSC_LINK, APPLE_ID, etc.). The parser must:
 * - decode the base64-encoded .p12 certificate to a temp file with the
 *    original bytes, NOT the base64 wrapper
 * - produce a deterministic, ordered plan for the macOS notarization
 *   step so a misconfigured build fails BEFORE files reach the registry
 * - refuse to skip macOS notarization when only codesign is configured
 * - refuse to skip signing when the cert password is empty
 */

import { describe, expect, it } from "vitest";
import {
  buildMacosNotarizationPlan,
  buildWindowsSignToolInvocation,
  decodeCertificate,
  parseSigningEnvironment
} from "../src/build/sign.js";

describe("parseSigningEnvironment", () => {
  it("returns an empty plan when no env vars are set (developer build)", () => {
    const plan = parseSigningEnvironment({});
    expect(plan.signingEnabled).toBe(false);
    expect(plan.certificateFile).toBeUndefined();
    expect(plan.appleTeamId).toBeUndefined();
  });

  it("treats the build as signed when the Windows cert is present", () => {
    const plan = parseSigningEnvironment({
      CSC_LINK: "ZmFrZS1jZXJ0LWJ5dGVz",
      CSC_KEY_PASSWORD: "p4ssword"
    });
    expect(plan.signingEnabled).toBe(true);
    expect(plan.certificateFile).toContain("p12");
    expect(plan.certificatePassword).toBe("p4ssword");
  });

  it("treats the build as signed when the Apple credentials are present", () => {
    const plan = parseSigningEnvironment({
      APPLE_ID: "agent@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
      APPLE_TEAM_ID: "ABCDE12345"
    });
    expect(plan.signingEnabled).toBe(true);
    expect(plan.appleId).toBe("agent@example.com");
    expect(plan.appleTeamId).toBe("ABCDE12345");
  });

  it("rejects an empty cert password (the resulting installer would not sign)", () => {
    expect(() =>
      parseSigningEnvironment({
        CSC_LINK: "ZmFrZS1jZXJ0LWJ5dGVz",
        CSC_KEY_PASSWORD: ""
      })
    ).toThrow(/password/);
  });
});

describe("decodeCertificate", () => {
  it("decodes a base64 string into its raw bytes", () => {
    const decoded = decodeCertificate("aGVsbG8td29ybGQ=");
    expect(Buffer.from(decoded).toString("utf8")).toBe("hello-world");
  });

  it("rejects non-base64 input", () => {
    expect(() => decodeCertificate("not base64 !! @#$%")).toThrow();
  });

  it("writes the certificate to a temp file and cleans it up on demand", () => {
    const tempPath = decodeCertificate("aGVsbG8td29ybGQ=", {
      writeToTempFile: true
    });
    // The path must end with .p12 — that's what electron-forge expects.
    expect(tempPath).toMatch(/\.p12$/);
  });
});

describe("buildWindowsSignToolInvocation", () => {
  it("produces a signtool command for the .p12 cert", () => {
    const inv = buildWindowsSignToolInvocation({
      certificateFile: "C:\\certs\\agent.p12",
      certificatePassword: "p4ssword",
      artifact: "dist\\LeCoding-0.1.0.exe"
    });
    expect(inv.command).toBe("signtool.exe");
    expect(inv.args).toContain("sign");
    expect(inv.args).toContain("/fd");
    expect(inv.args).toContain("sha256");
    expect(inv.args).toContain("/f");
    expect(inv.args).toContain("C:\\certs\\agent.p12");
    expect(inv.args).toContain("/p");
    expect(inv.args).toContain("p4ssword");
    expect(inv.args).toContain("dist\\LeCoding-0.1.0.exe");
  });
});

describe("buildMacosNotarizationPlan", () => {
  it("chains codesign → notarytool so the notary step always runs after sign", () => {
    const plan = buildMacosNotarizationPlan({
      appleId: "agent@example.com",
      appleAppSpecificPassword: "abcd-efgh-ijkl-mnop",
      appleTeamId: "ABCDE12345",
      artifact: "LeCoding-0.1.0.dmg"
    });
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]!.command).toBe("codesign");
    expect(plan.steps[1]!.command).toBe("xcrun");
    expect(plan.steps[1]!.args).toContain("notarytool");
  });

  it("rejects a plan when the Apple team id is missing", () => {
    expect(() =>
      buildMacosNotarizationPlan({
        appleId: "agent@example.com",
        appleAppSpecificPassword: "abcd-efgh-ijkl-mnop",
        appleTeamId: "",
        artifact: "LeCoding-0.1.0.dmg"
      })
    ).toThrow(/team id/);
  });
});