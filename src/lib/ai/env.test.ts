import { describe, expect, it } from "vitest";
import { coerceBridgeSecret } from "./env";

describe("coerceBridgeSecret (BP-001)", () => {
	it("returns undefined for undefined/empty input", () => {
		expect(coerceBridgeSecret(undefined)).toBeUndefined();
		expect(coerceBridgeSecret("")).toBeUndefined();
	});

	it("returns undefined for the shipped weak default", () => {
		expect(coerceBridgeSecret("noledge-secret-67890")).toBeUndefined();
	});

	it("returns undefined for case-insensitive known-weak defaults", () => {
		// Spot-check the most common accidental values an operator might type.
		expect(coerceBridgeSecret("CHANGEME")).toBeUndefined();
		expect(coerceBridgeSecret("Password")).toBeUndefined();
		expect(coerceBridgeSecret("DEV")).toBeUndefined();
	});

	it("returns undefined for secrets shorter than 32 chars", () => {
		expect(coerceBridgeSecret("a".repeat(31))).toBeUndefined();
		expect(coerceBridgeSecret("a".repeat(0))).toBeUndefined();
	});

	it("accepts a 32-char secret", () => {
		const secret = "a".repeat(32);
		expect(coerceBridgeSecret(secret)).toBe(secret);
	});

	it("accepts a 64-char secret (openssl rand -hex 32 output)", () => {
		const secret = "9".repeat(64);
		expect(coerceBridgeSecret(secret)).toBe(secret);
	});

	it("does not deny a substring that matches a bad default", () => {
		// Only exact full-match denial — "secret" embedded in a longer string is fine.
		const secret = `${"a".repeat(30)}secret`;
		expect(coerceBridgeSecret(secret)).toBe(secret);
	});
});
