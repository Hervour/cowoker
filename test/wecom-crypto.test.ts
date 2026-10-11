import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { wecomCrypto } from "../src/connectors/wecom.js";

function encryptForTest(message: string, encodingAesKey: string): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  const iv = key.subarray(0, 16);
  const messageBuffer = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBuffer.length);
  const body = Buffer.concat([randomBytes(16), length, messageBuffer, Buffer.from("corp-id")]);
  const padLength = 32 - (body.length % 32 || 32);
  const padding = Buffer.alloc(padLength < 1 ? 32 : padLength, padLength < 1 ? 32 : padLength);
  const padded = Buffer.concat([body, padding]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

test("WeCom payload decrypts with 32-byte PKCS#7 padding", () => {
  const key = Buffer.alloc(32, 7).toString("base64").replace(/=+$/, "");
  const encrypted = encryptForTest("hello cowoker", key);
  assert.equal(wecomCrypto.decryptPayload(encrypted, key), "hello cowoker");
});

test("WeCom signature sorts token, timestamp, nonce and ciphertext", () => {
  assert.equal(
    wecomCrypto.wecomSignature("token", "123", "nonce", "cipher"),
    wecomCrypto.wecomSignature("token", "123", "nonce", "cipher"),
  );
  assert.notEqual(
    wecomCrypto.wecomSignature("token", "123", "nonce", "cipher"),
    wecomCrypto.wecomSignature("token", "124", "nonce", "cipher"),
  );
});

