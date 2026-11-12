import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { Bridge, LanguageModel } from "../src/providers.js";
import { Pipeline } from "../src/pipeline.js";
import { runConfig, type Run } from "../src/domain.js";

async function fixture(key?: string) {
  const dir = mkdtempSync(join(tmpdir(), "social-lab-"));
  const value = await createApp({
    mode: "demo",
    dataDir: dir,
    apiKey: key,
    staticDir: resolve("public"),
  });
  return {
    ...value,
    dir,
    async cleanup() {
      await value.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function completed(store: Store, id: string) {
  for (let i = 0; i < 150; i++) {
    const run = store.run(id)!;
    if (["completed", "failed"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Pipeline timed out");
}
test("complete nine-stage demo, scheduled events, references, exploration and data persistence", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Teste",
        scenario: "Reação ao novo preço do produto",
        text: "Clientes recebem novos benefícios com o reajuste. A empresa explica os motivos.",
      },
    });
    assert.equal(response.statusCode, 201);
    const project = response.json();
    const created = await f.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/runs`,
      payload: {
        rounds: 3,
        platforms: ["twitter", "reddit"],
        events: [{ round: 1, agentId: 0, content: "Evento de teste" }],
      },
    });
    assert.equal(created.statusCode, 202);
    const run = await completed(f.store, created.json().id);
    assert.equal(run.status, "completed");
    assert.equal(run.stage, "exploracao");
    assert.equal(new Set(run.log.map((l) => l.stage)).size, 9);
    assert.equal(
      run.actions.filter((a) => a.content === "Evento de teste").length,
      2,
    );
    assert.ok(
      run.actions
        .filter((a) => a.content === "Evento de teste")
        .every((a) => a.round === 1),
    );
    assert.match(
      run.report!,
      new RegExp(`document:${project.documents[0].id}`),
    );
    assert.equal(
      new Set(run.actions.map((a) => a.id)).size,
      run.actions.length,
    );
    const answer = await f.app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/explore`,
      payload: { question: "Quais limitações?", agentId: 0 },
    });
    assert.equal(answer.statusCode, 200);
    assert.match(answer.json().answer, /DEMO/);
    const staticPage = await f.app.inject("/");
    assert.equal(staticPage.statusCode, 200);
    assert.match(
      staticPage.headers["content-security-policy"] as string,
      /script-src 'self'/,
    );
    await f.app.close();
    const reopened = new Store(join(f.dir, "lab.sqlite"));
    assert.equal(reopened.run(run.id)?.status, "completed");
    reopened.close();
  } finally {
    await f.cleanup();
  }
});
test("API requires bearer key, rejects invalid events and live mode cannot silently fall back to demo", async () => {
  const f = await fixture("test-secret");
  try {
    assert.equal((await f.app.inject("/api/projects")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/projects",
          headers: { authorization: "Bearer test-secret" },
        })
      ).statusCode,
      200,
    );
    assert.equal((await f.app.inject("/health")).statusCode, 200);
    assert.throws(() =>
      runConfig.parse({
        rounds: 2,
        events: [{ round: 2, agentId: 0, content: "x" }],
      }),
    );
    assert.throws(() => runConfig.parse({ platforms: ["twitter", "twitter"] }));
    await assert.rejects(createApp({ mode: "live", dataDir: f.dir }), /exige/);
  } finally {
    await f.cleanup();
  }
});
test("upload accepts Markdown and refuses unsupported files", async () => {
  const f = await fixture();
  try {
    const p = (
      await f.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "Upload",
          scenario: "Cenário de upload de referência",
          text: "Documento inicial para validação.",
        },
      })
    ).json();
    const upload = async (name: string) =>
      f.app.inject({
        method: "POST",
        url: `/api/projects/${p.id}/documents`,
        headers: { "content-type": "multipart/form-data; boundary=lab" },
        payload: `--lab\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nInformação adicional para o cenário.\r\n--lab--\r\n`,
      });
    assert.equal((await upload("contexto.md")).statusCode, 201);
    assert.equal((await upload("executavel.exe")).statusCode, 400);
    assert.equal(f.store.project(p.id)?.documents.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("restart marks unfinished work interrupted instead of replaying charged operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-restart-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    const run: Run = {
      id: "x",
      projectId: "p",
      mode: "live",
      status: "running",
      stage: "grafo",
      config: runConfig.parse({}),
      createdAt: "",
      updatedAt: "",
      log: [],
      personas: [],
      actions: [],
      llmCalls: 0,
      tokens: 0,
    };
    store.saveRun(run);
    store.close();
    store = new Store(path);
    assert.equal(store.run("x")?.status, "interrupted");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("live pipeline uses external contracts in order and fails closed on provider failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "social-contract-"));
  const store = new Store(join(dir, "state.sqlite"));
  const calls: string[] = [];
  store.saveProject({
    id: "p",
    name: "Contract",
    scenario: "Reação ao comunicado público",
    documents: [
      { id: "d", name: "doc.txt", text: "Referência verificável do cenário." },
    ],
    createdAt: "",
  });
  const bridge = {
    async graph(id: string) {
      calls.push("graph");
      return {
        id,
        origin: "zep",
        nodes: [
          { id: "node", name: "Empresa", summary: "Fonte", type: "Company" },
        ],
        edges: [],
      };
    },
    async start() {
      calls.push("start");
    },
    async step(id: string, round: number) {
      calls.push("step");
      return {
        actions: [
          {
            id: `${id}:${round}`,
            round,
            platform: "twitter",
            agentId: 0,
            type: "CREATE_POST",
            content: "Simulado",
            origin: "simulation_event",
          },
        ],
      };
    },
    async memory() {
      calls.push("memory");
    },
    async interview() {
      calls.push("interview");
      return { answer: "Resposta sintética" };
    },
    async search() {
      calls.push("search");
      return { facts: [] };
    },
    async close() {
      calls.push("close");
    },
  } as unknown as Bridge;
  const llm = {
    async structured(_run: Run, instruction: string) {
      return instruction.startsWith("Defina")
        ? {
            entityTypes: [{ name: "Company", description: "Empresa" }],
            relationTypes: [],
          }
        : {
            bio: "Empresa",
            persona: "Persona hipotética",
            activityProbability: 1,
            activeHours: [0, 1],
          };
    },
    async text() {
      return "Relatório [document:d]";
    },
  } as unknown as LanguageModel;
  try {
    const pipeline = new Pipeline(store, "live", llm, bridge);
    const run = await completed(
      store,
      pipeline.create(
        "p",
        runConfig.parse({ rounds: 1, platforms: ["twitter"] }),
      ).id,
    );
    assert.equal(run.status, "completed");
    assert.deepEqual(calls, [
      "graph",
      "start",
      "step",
      "memory",
      "interview",
      "search",
    ]);
    assert.equal(run.graph?.origin, "zep");
    const broken = {
      ...bridge,
      async step() {
        throw new Error("provider failure with private data");
      },
    } as unknown as Bridge;
    const failed = await completed(
      store,
      new Pipeline(store, "live", llm, broken).create(
        "p",
        runConfig.parse({ rounds: 1, platforms: ["twitter"] }),
      ).id,
    );
    assert.equal(failed.status, "failed");
    assert.ok(calls.includes("close"));
    assert.doesNotMatch(failed.error!, /private data/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
