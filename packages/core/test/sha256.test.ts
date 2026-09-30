import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/index.js";

describe("sha256 (pure implementation)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ])("matches the NIST vector for %j", (input, expected) => expect(sha256Hex(input)).toBe(expected));

  it("agrees with Node's crypto across block boundaries and unicode", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const s = "é✓a".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});
