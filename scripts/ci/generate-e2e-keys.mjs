// Disposable local/CI signing material. Never use these keys for deployed auth.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const dir = ".agent/scratch/phase-3";
mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { n, e } = publicKey.export({ format: "jwk" });
writeFileSync(`${dir}/e2e-jwks.json`, JSON.stringify({
  keys: [{ kty: "RSA", kid: "e2e-key-1", alg: "RS256", use: "sig", n, e }],
}, null, 2));
writeFileSync(`${dir}/e2e-key.der`, privateKey.export({ format: "der", type: "pkcs8" }), {
  mode: 0o600,
});
console.log("Generated disposable E2E JWKS and signing key.");
