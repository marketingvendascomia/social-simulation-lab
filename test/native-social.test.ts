import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateDecision, nativeRound } from "../src/native-social.js";
import {
  metrics,
  rng,
  runConfig,
  type Run,
  type Project,
  type Action,
} from "../src/domain.js";
import { Pipeline } from "../src/pipeline.js";
import { Store } from "../src/store.js";
import { Bridge, LanguageModel } from "../src/providers.js";
import { createApp } from "../src/app.js";

const project: Project = {
  id: "p",
  name: "Café",
  scenario: "Reação ao reajuste de preços no Café Aurora",
  documents: [
    {
      id: "d",
      name: "contexto.txt",
      text: "Caso fictício para explorar comunicação e atendimento.",
    },
  ],
  createdAt: "",
};
function runFixture(): Run {
  return {
    id: "r",
    projectId: "p",
    mode: "demo",
    status: "running",
    stage: "simulacao",
    config: runConfig.parse({ platforms: ["instagram", "google_reviews"] }),
    createdAt: "",
    updatedAt: "",
    log: [],
    actions: [],
    llmCalls: 0,
    tokens: 0,
    personas: [
      {
        id: 0,
        name: "Empresa",
        bio: "Hipótese",
        persona: "Empresa fictícia",
        sourceNodeId: "b",
        activityProbability: 1,
        activeHours: Array.from({ length: 24 }, (_, i) => i),
      },
      {
        id: 1,
        name: "Cliente",
        bio: "Hipótese",
        persona: "Cliente fictício",
        sourceNodeId: "c",
        activityProbability: 1,
        activeHours: Array.from({ length: 24 }, (_, i) => i),
      },
    ],
  };
}
async function waitRun(store: Store, id: string) {
  for (let n = 0; n < 150; n++) {
    const run = store.run(id)!;
    if (["completed", "failed"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timeout");
}
test("Google permissions, star bounds, duplicate reviews and one business reply", () => {
  const run = runFixture();
  const business = run.personas[0]!,
    customer = run.personas[1]!;
  const decision = {
    type: "CREATE_REVIEW",
    stars: 2,
    content: "Hipótese de avaliação",
  };
  assert.throws(() =>
    validateDecision(run, "google_reviews", business, 0, decision, []),
  );
  assert.throws(() =>
    validateDecision(
      run,
      "google_reviews",
      customer,
      0,
      { ...decision, stars: 6 },
      [],
    ),
  );
  const review = validateDecision(
    run,
    "google_reviews",
    customer,
    0,
    decision,
    [],
  )!;
  assert.throws(() =>
    validateDecision(run, "google_reviews", customer, 1, decision, [review]),
  );
  const response = {
    type: "REPLY_REVIEW",
    targetId: review.id,
    content: "Resposta hipotética",
  };
  assert.throws(() =>
    validateDecision(run, "google_reviews", customer, 1, response, [review]),
  );
  assert.throws(() =>
    validateDecision(
      run,
      "google_reviews",
      business,
      1,
      { ...response, targetId: "foreign" },
      [review],
    ),
  );
  const reply = validateDecision(run, "google_reviews", business, 1, response, [
    review,
  ])!;
  assert.throws(() =>
    validateDecision(run, "google_reviews", business, 2, response, [
      review,
      reply,
    ]),
  );
  const m = metrics([
    review,
    reply,
    { ...review, id: "announcement", type: "ANNOUNCEMENT", stars: undefined },
  ]);
  assert.equal(m.googleReviews.averageStars, 2);
  assert.equal(m.googleReviews.count, 1);
  assert.equal(m.googleReviews.answered, 1);
  assert.equal(m.googleReviews.responseRate, 100);
  assert.equal(metrics([]).googleReviews.averageStars, null);
});
test("Instagram comments/likes require same-platform visible post, and likes cannot repeat", () => {
  const run = runFixture();
  const customer = run.personas[1]!;
  const post: Action = {
    id: "post",
    round: 0,
    platform: "instagram",
    agentId: 0,
    type: "CREATE_POST",
    content: "Legenda fictícia",
    origin: "simulation_event",
  };
  assert.throws(() =>
    validateDecision(
      run,
      "instagram",
      customer,
      1,
      { type: "CREATE_COMMENT", targetId: "missing", content: "Comentário" },
      [post],
    ),
  );
  assert.throws(() =>
    validateDecision(
      run,
      "instagram",
      customer,
      1,
      { type: "LIKE_POST", targetId: "post" },
      [{ ...post, platform: "twitter" }],
    ),
  );
  const like = validateDecision(
    run,
    "instagram",
    customer,
    1,
    { type: "LIKE_POST", targetId: "post" },
    [post],
  )!;
  assert.throws(() =>
    validateDecision(
      run,
      "instagram",
      customer,
      2,
      { type: "LIKE_POST", targetId: "post" },
      [post, like],
    ),
  );
  assert.throws(() =>
    validateDecision(
      run,
      "instagram",
      customer,
      1,
      { type: "CREATE_REVIEW", stars: 5, content: "Não permitido" },
      [post],
    ),
  );
});
test("native rounds keep announcements out of ratings, use snapshots and honor activity hours", async () => {
  const run = runFixture();
  run.config.events = [
    { round: 0, agentId: 0, content: "Comunicado de teste" },
  ];
  const first = await nativeRound(run, project, "google_reviews", 0, rng(42));
  assert.equal(first.filter((a) => a.type === "ANNOUNCEMENT").length, 1);
  assert.equal(first.filter((a) => a.type === "CREATE_REVIEW").length, 1);
  assert.equal(first.filter((a) => a.type === "REPLY_REVIEW").length, 0);
  run.actions.push(...first);
  const second = await nativeRound(run, project, "google_reviews", 1, rng(42));
  assert.equal(second.filter((a) => a.type === "REPLY_REVIEW").length, 1);
  assert.equal(second.filter((a) => a.type === "CREATE_REVIEW").length, 0);
  run.personas.forEach((p) => (p.activeHours = [10]));
  assert.equal(
    (await nativeRound(run, project, "google_reviews", 2, rng(42))).length,
    0,
  );
});
test("Brazilian platforms complete demo through HTTP and produce platform-specific report/metrics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "social-brazil-"));
  const { app, store } = await createApp({
    mode: "demo",
    dataDir: dir,
    staticDir: resolve("public"),
  });
  try {
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: project.name,
          scenario: project.scenario,
          text: project.documents[0]!.text,
        },
      })
    ).json();
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${p.id}/runs`,
      payload: {
        platforms: ["instagram", "google_reviews"],
        rounds: 5,
        events: [{ round: 0, agentId: 0, content: "Condições da oferta" }],
      },
    });
    assert.equal(created.statusCode, 202);
    const run = await waitRun(store, created.json().id);
    assert.equal(run.status, "completed");
    assert.equal(new Set(run.log.map((l) => l.stage)).size, 9);
    const response = (await app.inject(`/api/runs/${run.id}`)).json();
    assert.ok(response.metrics.instagram.comments > 0);
    assert.ok(response.metrics.googleReviews.count > 0);
    assert.ok(
      run.actions
        .filter((a) => a.type === "CREATE_REVIEW")
        .every((a) => a.agentId !== 0 && a.stars! >= 1 && a.stars! <= 5),
    );
    assert.match(run.report!, /Instagram simulado/);
    assert.match(run.report!, /Avaliações Google simuladas/);
    const question = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/explore`,
      payload: {
        question: "O que achou?",
        agentId: 1,
        platform: "google_reviews",
      },
    });
    assert.equal(question.statusCode, 200);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/explore`,
      payload: { question: "O que achou?", agentId: 1, platform: "reddit" },
    });
    assert.equal(invalid.statusCode, 409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("live native simulation uses Node decisions and interviews without starting an OASIS session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "social-native-live-"));
  const store = new Store(join(dir, "state.sqlite"));
  store.saveProject(project);
  const calls: string[] = [];
  const bridge = {
    async graph(id: string) {
      calls.push("graph");
      return {
        id,
        origin: "zep",
        nodes: [
          { id: "b", name: "Empresa", summary: "Fonte", type: "Company" },
          { id: "c", name: "Cliente", summary: "Fonte", type: "Person" },
        ],
        edges: [],
      };
    },
    async start() {
      throw new Error("OASIS must not start");
    },
    async step() {
      throw new Error("OASIS must not step");
    },
    async interview() {
      throw new Error("OASIS must not interview");
    },
    async memory() {
      calls.push("memory");
    },
    async search() {
      calls.push("search");
      return { facts: [] };
    },
  } as unknown as Bridge;
  const llm = {
    async structured(_run: Run, instruction: string, context: any) {
      if (instruction.startsWith("Defina"))
        return {
          entityTypes: [{ name: "Person", description: "Pessoa" }],
          relationTypes: [],
        };
      if (instruction.startsWith("Crie persona"))
        return {
          bio: "Hipótese",
          persona: "Persona sintética",
          activityProbability: 1,
          activeHours: [0, 1],
        };
      calls.push("decision");
      const reviews = context.visibleActions.filter(
        (a: Action) => a.type === "CREATE_REVIEW",
      );
      if (context.agent.id === 0)
        return reviews.length
          ? {
              type: "REPLY_REVIEW",
              targetId: reviews[0].id,
              content: "Resposta sintética",
            }
          : { type: "WAIT" };
      return reviews.length
        ? { type: "WAIT" }
        : { type: "CREATE_REVIEW", stars: 4, content: "Avaliação sintética" };
    },
    async text() {
      calls.push("text");
      return "Resposta sintética [document:d]";
    },
  } as unknown as LanguageModel;
  try {
    const pipeline = new Pipeline(store, "live", llm, bridge);
    const run = await waitRun(
      store,
      pipeline.create(
        "p",
        runConfig.parse({
          platforms: ["google_reviews"],
          rounds: 2,
          maxAgents: 2,
        }),
      ).id,
    );
    assert.equal(run.status, "completed");
    assert.equal(metrics(run.actions).googleReviews.averageStars, 4);
    assert.equal(metrics(run.actions).googleReviews.answered, 1);
    assert.ok(calls.includes("memory"));
    const answer = await pipeline.explore(
      run.id,
      "Qual sua opinião?",
      1,
      "google_reviews",
    );
    assert.match(answer.answer, /sintética/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
