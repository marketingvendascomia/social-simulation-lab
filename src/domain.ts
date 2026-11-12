import { z } from "zod";

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
    platforms: z
      .array(z.enum(["twitter", "reddit"]))
      .min(1)
      .max(2)
      .default(["twitter"]),
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
  return {
    totalActions: actions.length,
    activeAgents: new Set(actions.map((a) => a.agentId)).size,
    byType,
  };
}
