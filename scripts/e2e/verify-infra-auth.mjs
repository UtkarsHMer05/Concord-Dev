#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Authenticated browser-E2E infrastructure proof.
//
// The browser journey proves the gateway's product behavior. This companion
// probe proves the disposable NATS/Redis infrastructure cannot silently fall
// back to anonymous access: it checks rejected anonymous/wrong credentials,
// successful least-privilege commands, and the JetStream API. It never logs a
// connection URL, username, password, or server response body.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const timeoutMs = Number(process.env.CONCORD_E2E_INFRA_TIMEOUT_MS ?? "10000");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
  throw new Error("CONCORD_E2E_INFRA_TIMEOUT_MS must be an integer from 1 to 30000");
}

function requiredUrl(name, protocols) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for the authenticated E2E infrastructure probe`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use one of: ${protocols.join(", ")}`);
  }
  if (!parsed.hostname || !parsed.port || !parsed.username || !parsed.password) {
    throw new Error(`${name} must include an explicit host, port, username, and password`);
  }
  if (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    throw new Error(`${name} must include a valid TCP port`);
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error(`${name} must not include a path, query, or fragment`);
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error(`${name} contains invalid percent-encoded credentials`);
  }
  return parsed;
}

function withTimeout(label, operation) {
  let cancel = () => {};
  let cancelled = false;
  const dispose = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      cancel();
    } catch {
      // The operation is already being torn down; preserve the original
      // timeout/connection error rather than replacing it with cleanup noise.
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dispose();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${label} timed out`)), timeoutMs);
    try {
      cancel = operation(
        (value) => {
          finish(resolve, value);
        },
        (error) => {
          finish(reject, error instanceof Error ? error : new Error(String(error)));
        },
      ) || (() => {});
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function openSocket(url) {
  const options = { host: url.hostname, port: Number(url.port) };
  return url.protocol === "tls:" || url.protocol === "rediss:"
    ? tls.connect({ ...options, servername: url.hostname })
    : net.createConnection(options);
}

function natsCredentials(url) {
  return url.username
    ? {
        user: decodeURIComponent(url.username),
        pass: decodeURIComponent(url.password),
      }
    : {};
}

async function natsUntil(url, payload, predicate, label) {
  return withTimeout(label, (resolve, reject) => {
    const socket = openSocket(url);
    let transcript = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.once("error", () => finish(reject, new Error(`${label}: NATS connection failed`)));
    socket.once("close", () => {
      if (!settled) finish(reject, new Error(`${label}: NATS connection closed before the expected reply`));
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, ...natsCredentials(url) })}\r\n${payload}`);
    });
    socket.on("data", (chunk) => {
      transcript += chunk.toString("utf8");
      if (predicate(transcript)) {
        finish(resolve, transcript);
      } else if (transcript.includes("-ERR")) {
        finish(reject, new Error(`${label}: NATS rejected an expected authenticated command`));
      }
    });
    return () => socket.destroy();
  });
}

function natsWithoutCredentials(url) {
  const clone = new URL(url);
  clone.username = "";
  clone.password = "";
  return clone;
}

function natsWrongCredentials(url) {
  const clone = new URL(url);
  clone.username = "concord_e2e_wrong";
  clone.password = "definitely-wrong";
  return clone;
}

async function verifyNats(url) {
  await natsUntil(
    natsWithoutCredentials(url),
    "PING\r\n",
    (reply) => reply.includes("-ERR"),
    "NATS anonymous rejection",
  );
  await natsUntil(
    natsWrongCredentials(url),
    "PING\r\n",
    (reply) => reply.includes("-ERR"),
    "NATS wrong-password rejection",
  );

  const inbox = `_INBOX.concord_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
  const namesInbox = `_INBOX.concord_e2e_names_${crypto.randomUUID().replaceAll("-", "")}`;
  const subject = "concord.e2e.auth.probe";
  await natsUntil(
    url,
    [
      `SUB ${subject} 1`,
      `PUB ${subject} 5`,
      "hello",
      `SUB ${inbox} 2`,
      `SUB ${namesInbox} 3`,
      `PUB $JS.API.INFO ${inbox} 0`,
      "",
      `PUB $JS.API.STREAM.NAMES ${namesInbox} 0`,
      "",
      "PING",
      "",
    ].join("\r\n"),
    (reply) =>
      reply.includes(`MSG ${subject} 1 5\r\nhello`) &&
      reply.includes(`MSG ${inbox} 2`) &&
      reply.includes("jetstream.api.v1.account_info_response") &&
      reply.includes(`MSG ${namesInbox} 3`) &&
      reply.includes("jetstream.api.v1.stream_names_response") &&
      reply.includes("PONG"),
    "NATS authenticated JetStream and pub/sub probe",
  );
}

function respCommand(parts) {
  return Buffer.concat([
    Buffer.from(`*${parts.length}\r\n`),
    ...parts.flatMap((part) => {
      const bytes = Buffer.from(part, "utf8");
      return [Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")];
    }),
  ]);
}

function readRespLine(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset, "utf8");
  if (end < 0) return null;
  return { value: buffer.toString("utf8", offset, end), next: end + 2 };
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = readRespLine(buffer, offset + 1);
  if (!line) return null;
  if (type === "+" || type === "-" || type === ":") {
    return {
      value: { type: type === "+" ? "simple" : type === "-" ? "error" : "integer", value: line.value },
      next: line.next,
    };
  }
  if (type === "$") {
    const length = Number(line.value);
    if (!Number.isInteger(length)) throw new Error("Redis returned a malformed bulk length");
    if (length === -1) return { value: { type: "bulk", value: null }, next: line.next };
    if (length < -1) throw new Error("Redis returned an invalid bulk length");
    const end = line.next + length;
    if (buffer.length < end + 2) return null;
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) {
      throw new Error("Redis returned a bulk value without a CRLF terminator");
    }
    return { value: { type: "bulk", value: buffer.toString("utf8", line.next, end) }, next: end + 2 };
  }
  if (type === "*") {
    const count = Number(line.value);
    if (!Number.isInteger(count) || count < -1) throw new Error("Redis returned a malformed array length");
    if (count === -1) return { value: { type: "array", value: null }, next: line.next };
    const values = [];
    let next = line.next;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseResp(buffer, next);
      if (!parsed) return null;
      values.push(parsed.value);
      next = parsed.next;
    }
    return { value: { type: "array", value: values }, next };
  }
  throw new Error("Redis returned an unsupported RESP type");
}

async function redisReplies(url, commands, label) {
  return withTimeout(label, (resolve, reject) => {
    const socket = openSocket(url);
    let buffer = Buffer.alloc(0);
    const replies = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.once("error", () => finish(reject, new Error(`${label}: Redis connection failed`)));
    socket.once("close", () => {
      if (!settled) finish(reject, new Error(`${label}: Redis connection closed before all replies`));
    });
    socket.once("connect", () => socket.write(Buffer.concat(commands.map(respCommand))));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        let offset = 0;
        while (true) {
          const parsed = parseResp(buffer, offset);
          if (!parsed) break;
          replies.push(parsed.value);
          offset = parsed.next;
        }
        if (offset > 0) buffer = buffer.subarray(offset);
        if (replies.length === commands.length) finish(resolve, replies);
      } catch {
        finish(reject, new Error(`${label}: Redis returned an unreadable response`));
      }
    });
    return () => socket.destroy();
  });
}

function expectRedisError(reply, label) {
  if (reply?.type !== "error") throw new Error(`${label}: Redis unexpectedly accepted the command`);
}

function expectRedisSuccess(reply, label) {
  if (!reply || reply.type === "error") throw new Error(`${label}: Redis rejected an allowed command`);
}

async function verifyRedis(url) {
  const anonymous = await redisReplies(url, [["PING"]], "Redis anonymous rejection");
  expectRedisError(anonymous[0], "Redis anonymous rejection");

  const wrong = await redisReplies(
    url,
    [["AUTH", decodeURIComponent(url.username), "definitely-wrong"]],
    "Redis wrong-password rejection",
  );
  expectRedisError(wrong[0], "Redis wrong-password rejection");

  const key = "concord:e2e:auth-probe";
  const outsideKey = "outside:e2e:auth-probe";
  const replies = await redisReplies(
    url,
    [
      ["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)],
      ["PING"],
      ["INCR", key],
      ["EXPIRE", key, "30"],
      ["HSET", `${key}:presence`, "user", "present"],
      ["SCAN", "0", "MATCH", "concord:e2e:*"],
      ["DEL", key, `${key}:presence`],
      ["INCR", outsideKey],
      ["SET", key, "forbidden"],
      ["FLUSHALL"],
    ],
    "Redis authenticated ACL probe",
  );
  for (const [index, label] of [
    [0, "Redis AUTH"],
    [1, "Redis PING"],
    [2, "Redis INCR"],
    [3, "Redis EXPIRE"],
    [4, "Redis HSET"],
    [5, "Redis SCAN"],
    [6, "Redis DEL"],
  ]) {
    expectRedisSuccess(replies[index], label);
  }
  expectRedisError(replies[7], "Redis key namespace restriction");
  expectRedisError(replies[8], "Redis SET restriction");
  expectRedisError(replies[9], "Redis FLUSHALL restriction");
}

const natsUrl = requiredUrl("CONCORD_E2E_NATS_URL", ["nats:", "tls:"]);
const redisUrl = requiredUrl("CONCORD_E2E_REDIS_URL", ["redis:", "rediss:"]);

await verifyNats(natsUrl);
console.log("NATS authenticated JetStream, publish/subscribe, and negative-auth checks: PASS");
await verifyRedis(redisUrl);
console.log("Redis ACL allowed-command and negative-auth checks: PASS");
