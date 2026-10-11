import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { qqCrypto } from "../src/connectors/qq.js";

test("QQ callback validation matches the official example", () => {
  const { privateKey } = qqCrypto.deriveKeys("DG5g3B4j9X2KOErG");
  const signature = sign(null, Buffer.from("1725442341Arq0D5A61EgUu4OxUvOp"), privateKey).toString("hex");
  assert.equal(
    signature,
    "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
  );
});

test("QQ webhook signatures verify with the derived public key", () => {
  const { privateKey, publicKey } = qqCrypto.deriveKeys("test-secret");
  const timestamp = "1725442341";
  const body = Buffer.from('{"op":0,"t":"C2C_MESSAGE_CREATE"}');
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey);
  assert.equal(verify(null, Buffer.concat([Buffer.from(timestamp), body]), publicKey, signature), true);
});
