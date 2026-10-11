import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadId = "thr_fake";
let turnId = "turn_fake";
let approvalsReviewer = "user";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: process.cwd(), platformFamily: "windows", platformOs: "windows" } });
    return;
  }
  if (message.method === "thread/start") {
    approvalsReviewer = message.params.approvalsReviewer;
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/resume") {
    approvalsReviewer = message.params.approvalsReviewer;
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    turnId = "turn_fake";
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { id: "item_fake", type: "commandExecution", command: "echo approved", cwd: process.cwd(), status: "inProgress" } } });
    send({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId,
        turnId,
        itemId: "item_fake",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "echo approved",
        cwd: process.cwd(),
        reason: "test approval"
      }
    });
    return;
  }
  if (message.id === 900 && message.result) {
    const decision = message.result.decision;
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: "msg_fake", type: "agentMessage", text: `fake response:${decision}:${approvalsReviewer}` } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});