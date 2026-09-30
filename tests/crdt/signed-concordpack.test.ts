import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ConcordEngine } from "@/lib/crdt/runtime";
import { archiveTrust, verifySignedConcordPack, type SignedManifest } from "@/lib/crdt/signed-concordpack";
import { bytesToHex, concatBytes, operationLeaf, operationRoot, sha256Bytes } from "@/lib/crdt/proofs";

async function loadFactory() {
  const source = await readFile(path.resolve("wasm/dist/concord-crdt.js"), "utf8");
  const binary = await readFile(path.resolve("wasm/dist/concord-crdt.wasm"));
  const load = new Function(`${source}; return loadConcordCrdt;`)();
  return await load({ instantiateWasm(info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
    WebAssembly.instantiate(binary, info).then((result) => receive(result.instance)); return {};
  } }) as never;
}

it("verifies real retained WASM states with independent trust and rejects altered history", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const engine = await ConcordEngine.create(7n, loadFactory);
  try {
    const operations = [engine.localInsertText(0, 0x68)];
    const firstDigest = engine.digest();
    operations.push(engine.localInsertText(1, 0x69));
    const snapshot = engine.exportSnapshot();
    const payload = concatBytes(snapshot, ...operations);
    const opMeta = await Promise.all(operations.map(async (op, i) => ({ seq: String(i + 1), operationId: `7:${i + 1}`, checksum: bytesToHex(await sha256Bytes(op)), bytes: op.length })));
    const source = "11111111-1111-4111-8111-111111111111";
    const revision = "22222222-2222-4222-8222-222222222222";
    const c: SignedManifest["content"] = { format: "concordpack", version: 2, documentId: source, title: "Portable RFC", seq: "2", floorSeq: "0", baseSnapshotSeq: "0",
      stateDigest: engine.digest(), root: await operationRoot(await Promise.all(opMeta.map((o) => operationLeaf(o.seq, o.operationId, o.checksum)))), exportedAtMs: "1",
      snapshots: [{ snapshotId: "33333333-3333-4333-8333-333333333333", seq: "2", opCount: "2", stateDigest: engine.digest(), bytes: snapshot.length }],
      operations: opMeta, revisions: [{ revisionId: revision, seq: "1", kind: "named", label: "Baseline", createdBy: null, createdAtMs: "1", snapshotId: null, restoreSourceRevision: null, stateDigest: firstDigest }],
      provenance: null, payloadDigest: bytesToHex(await sha256Bytes(payload)) };
    const keyId = bytesToHex(await sha256Bytes(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))).slice(0, 16);
    const encode = async (content: SignedManifest["content"]) => {
      const message = concatBytes(new TextEncoder().encode("Concordpack signed history v2\0"), await sha256Bytes(new TextEncoder().encode(JSON.stringify(content))));
      const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, message.slice().buffer as ArrayBuffer)));
      const manifest: SignedManifest = { content, publicKey, keyId, signature };
      const json = new TextEncoder().encode(JSON.stringify(manifest)); const header = new Uint8Array(9);
      header.set(new TextEncoder().encode("CNCP\x02")); new DataView(header.buffer).setUint32(5, json.length, true);
      return { bytes: concatBytes(header, json, payload), trust: archiveTrust(manifest) };
    };
    const { bytes, trust } = await encode(c);
    const good = await verifySignedConcordPack(bytes, { ...trust, revisionId: revision }, loadFactory);
    expect(good.visibleContent).toEqual(JSON.parse(engine.visibleJson()));
    expect(good.manifest.content.revisions[0].stateDigest).toBe(firstDigest);
    for (const wrong of [{ ...trust, publicKey: "0".repeat(64) }, { ...trust, documentId: revision }, { ...trust, seq: "3" }, { ...trust, baseSnapshotSeq: "1" }]) {
      await expect(verifySignedConcordPack(bytes, wrong, loadFactory)).rejects.toThrow(/does not match/);
    }
    const damaged = bytes.slice(); damaged[damaged.length - 1] ^= 1;
    await expect(verifySignedConcordPack(damaged, trust, loadFactory)).rejects.toThrow(/checksum/);
    await expect(verifySignedConcordPack(bytes.slice(0, -1), trust, loadFactory)).rejects.toThrow(/checksum/);
    // Even a trusted signature cannot bypass native state/identity checks.
    const wrongState = await encode({ ...c, stateDigest: `sha256:${"0".repeat(64)}` });
    await expect(verifySignedConcordPack(wrongState.bytes, wrongState.trust, loadFactory)).rejects.toThrow(/Document CRDT digest/);
    const wrongRevision = await encode({ ...c, revisions: [{ ...c.revisions[0], stateDigest: `sha256:${"0".repeat(64)}` }] });
    await expect(verifySignedConcordPack(wrongRevision.bytes, wrongRevision.trust, loadFactory)).rejects.toThrow(/revision CRDT digest/);
    const falsePruning = await encode({ ...c, revisions: [{ ...c.revisions[0], stateDigest: null }] });
    await expect(verifySignedConcordPack(falsePruning.bytes, falsePruning.trust, loadFactory)).rejects.toThrow(/incorrectly marked as pruned/);
  } finally { engine.free(); }
});
