import { z } from "zod";

export const platformSchema = z.enum([
  "instagram",
  "google_reviews",
  "twitter",
  "reddit",
]);
export type Platform = z.infer<typeof platformSchema>;
export const isNativePlatform = (
  platform: string,
): platform is "instagram" | "google_reviews" =>
  platform === "instagram" || platform === "google_reviews";
export const isOasisPlatform = (platform: string) =>
  platform === "twitter" || platform === "reddit";

export const stages = [
  "entrada",
  "ontologia",
  "grafo",
  "personas",
  "preparacao",
  "simulacao",
  "memoria",
  "relatorio",
  "exploracao",
] as const;
export const runConfig = z
  .object({
    rounds: z.number().int().min(1).max(20).default(5),
    maxAgents: z.number().int().min(2).max(20).default(4),
    minutesPerRound: z.number().int().min(1).max(120).default(60),
    platforms: z.array(platformSchema).min(1).max(2).default(["instagram"]),
    businessAgentId: z.number().int().min(0).max(19).default(0),
    seed: z.number().int().min(0).max(2147483647).default(42),
    memory: z.boolean().default(true),
    events: z
      .array(
        z.object({
          round: z.number().int().min(0).max(19),
          content: z.string().min(1).max(2000),
          agentId: z.number().int().min(0).max(19).default(0),
        }),
      )
      .max(10)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.businessAgentId >= v.maxAgents)
      ctx.addIssue({
        code: "custom",
        message: "Agente da empresa fora dos limites",
      });
    if (new Set(v.platforms).size !== v.platforms.length)
      ctx.addIssue({ code: "custom", message: "Plataformas duplicadas" });
    if (v.events.some((e) => e.round >= v.rounds || e.agentId >= v.maxAgents))
      ctx.addIssue({
        code: "custom",
        message: "Evento fora dos limites de rodadas/agentes",
      });
  });
export type RunConfig = z.infer<typeof runConfig>;
export const ontologySchema = z.object({
  entityTypes: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z][A-Za-z]{0,39}$/),
        description: z.string().max(300),
      }),
    )
    .min(1)
    .max(10),
  relationTypes: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z][A-Z_]{0,39}$/),
        description: z.string().max(300),
      }),
    )
    .max(10),
});
export type Ontology = z.infer<typeof ontologySchema>;
export interface Document {
  id: string;
  name: string;
  text: string;
}
export interface Project {
  id: string;
  name: string;
  scenario: string;
  documents: Document[];
  createdAt: string;
}
export interface GraphNode {
  id: string;
  name: string;
  summary: string;
  type: string;
}
export interface Graph {
  id: string;
  nodes: GraphNode[];
  edges: { source: string; target: string; fact: string }[];
  origin: "demo" | "zep";
}
export interface Persona {
  id: number;
  name: string;
  bio: string;
  persona: string;
  sourceNodeId: string;
  activityProbability: number;
  activeHours: number[];
}
export const personaSchema = z.object({
  bio: z.string().min(1).max(1000),
  persona: z.string().min(1).max(4000),
  activityProbability: z.number().min(0).max(1),
  activeHours: z.array(z.number().int().min(0).max(23)).min(1).max(24),
});
export interface Action {
  id: string;
  round: number;
  platform: string;
  agentId: number;
  type: string;
  content: string;
  origin: "simulation_event";
  targetId?: string;
  stars?: number;
}
export interface Run {
  id: string;
  projectId: string;
  mode: "demo" | "live";
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  stage: (typeof stages)[number];
  config: RunConfig;
  createdAt: string;
  updatedAt: string;
  log: { stage: string; message: string; at: string }[];
  ontology?: Ontology;
  graph?: Graph;
  personas: Persona[];
  actions: Action[];
  report?: string;
  error?: string;
  llmCalls: number;
  tokens: number;
}
export function chunks(text: string, size = 3000): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size)
    result.push(text.slice(i, i + size));
  return result;
}
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
export function metrics(actions: Action[]) {
  const byType: Record<string, number> = {};
  for (const a of actions) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const reviews = actions.filter(
    (a) =>
      a.platform === "google_reviews" &&
      a.type === "CREATE_REVIEW" &&
      Number.isInteger(a.stars) &&
      a.stars! >= 1 &&
      a.stars! <= 5,
  );
  const reviewIds = new Set(reviews.map((a) => a.id));
  const replied = new Set(
    actions
      .filter(
        (a) =>
          a.platform === "google_reviews" &&
          a.type === "REPLY_REVIEW" &&
          a.targetId &&
          reviewIds.has(a.targetId),
      )
      .map((a) => a.targetId),
  );
  const histogram = Object.fromEntries(
    [1, 2, 3, 4, 5].map((stars) => [
      stars,
      reviews.filter((a) => a.stars === stars).length,
    ]),
  );
  const instagram = actions.filter((a) => a.platform === "instagram");
  return {
    totalActions: actions.length,
    activeAgents: new Set(actions.map((a) => a.agentId)).size,
    byType,
    instagram: {
      posts: instagram.filter((a) => a.type === "CREATE_POST").length,
      comments: instagram.filter((a) => a.type === "CREATE_COMMENT").length,
      likes: instagram.filter((a) => a.type === "LIKE_POST").length,
    },
    googleReviews: {
      count: reviews.length,
      averageStars: reviews.length
        ? Number(
            (
              reviews.reduce((sum, a) => sum + a.stars!, 0) / reviews.length
            ).toFixed(2),
          )
        : null,
      histogram,
      answered: replied.size,
      unanswered: reviews.length - replied.size,
      responseRate: reviews.length
        ? Number(((replied.size / reviews.length) * 100).toFixed(1))
        : null,
    },
  };
}
