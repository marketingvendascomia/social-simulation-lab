"""Single-worker, local bridge. Provider calls are never silently replayed.

OASIS operations follow the public CAMEL-AI API. This adapter is independent
implementation; MiroFish source is not bundled. See README for validation limits.
"""
import asyncio
import csv
import hmac
import json
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from bridge.core import active_ids, chunks, events_for

load_dotenv()
ROOT = Path(os.getenv("BRIDGE_DATA_DIR", "./data/bridge")).resolve()
TOKEN = os.getenv("BRIDGE_TOKEN", "")
SESSIONS = {}
CREATION_LOCK = asyncio.Lock()


def authenticate(authorization: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(401, "Bridge token required")


def identifier(value: str):
    if not re.fullmatch(r"[a-f0-9-]{36}", value):
        raise HTTPException(400, "Invalid run identifier")
    return value


def directory(value: str):
    result = ROOT / identifier(value)
    result.mkdir(parents=True, exist_ok=True)
    return result


def zep():
    from zep_cloud import Zep
    key = os.getenv("ZEP_API_KEY")
    if not key or os.getenv("ZEP_API_URL"):
        raise HTTPException(503, "ZEP_API_KEY required; only Zep Cloud is supported")
    return Zep(api_key=key, base_url="https://api.getzep.com/api/v2", timeout=60)


def wait_episode(client, episode):
    uuid = getattr(episode, "uuid_", None) or getattr(episode, "uuid", None)
    if not uuid:
        raise RuntimeError("Zep returned no episode identity")
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if client.graph.episode.get(uuid_=uuid).processed:
            return
        time.sleep(2)
    raise TimeoutError("Zep ingestion deadline exceeded")


def pages(call, graph_id):
    result, seen, cursor = [], set(), None
    while True:
        response = call(graph_id, limit=100, **({"cursor": cursor} if cursor else {}))
        result.extend(response.data or [])
        cursor = response.headers.get("zep-next-cursor")
        if not cursor:
            return result
        if cursor in seen:
            raise RuntimeError("Non-advancing Zep cursor")
        seen.add(cursor)
        if len(result) > 10000:
            raise RuntimeError("Graph exceeds MVP inventory limit")


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Document(Payload):
    id: str
    name: str = Field(max_length=180)
    text: str = Field(min_length=1, max_length=250000)


class GraphRequest(Payload):
    id: str
    ontology: dict
    documents: list[Document] = Field(min_length=1, max_length=8)


class Event(Payload):
    round: int = Field(ge=0, le=19)
    content: str = Field(min_length=1, max_length=2000)
    agentId: int = Field(ge=0, le=19)


class SimulationConfig(Payload):
    rounds: int = Field(ge=1, le=20)
    maxAgents: int = Field(ge=2, le=20)
    minutesPerRound: int = Field(ge=1, le=120)
    platforms: list[Literal["twitter", "reddit"]] = Field(min_length=1, max_length=2)
    seed: int = Field(ge=0, le=2147483647)
    memory: bool
    events: list[Event] = Field(max_length=10)


class Persona(Payload):
    id: int = Field(ge=0, le=19)
    name: str = Field(min_length=1, max_length=300)
    bio: str = Field(max_length=1000)
    persona: str = Field(max_length=4000)
    sourceNodeId: str
    activityProbability: float = Field(ge=0, le=1)
    activeHours: list[int] = Field(min_length=1, max_length=24)


class SessionRequest(Payload):
    id: str
    personas: list[Persona] = Field(min_length=1, max_length=20)
    config: SimulationConfig


class RoundRequest(Payload):
    round: int = Field(ge=0, le=19)


class InterviewRequest(Payload):
    agentId: int = Field(ge=0, le=19)
    platform: Literal["twitter", "reddit"]
    question: str = Field(min_length=3, max_length=2000)


class SearchRequest(Payload):
    query: str = Field(min_length=1, max_length=400)


class MemoryRequest(Payload):
    actions: list[dict] = Field(max_length=2000)


@asynccontextmanager
async def lifespan(app):
    if not TOKEN:
        raise RuntimeError("Set BRIDGE_TOKEN before starting the bridge")
    ROOT.mkdir(parents=True, exist_ok=True)
    yield
    for session in list(SESSIONS.values()):
        for env in session["environments"].values():
            await env.close()


app = FastAPI(title="Social Simulation Lab Bridge", lifespan=lifespan, dependencies=[Depends(authenticate)])


@app.get("/health")
def health():
    return {"status": "ok", "sessions": len(SESSIONS), "providersTested": False}


@app.post("/graphs")
def build_graph(body: GraphRequest):
    from zep_cloud.external_clients.ontology import EntityModel, EdgeModel
    folder = directory(body.id)
    marker = folder / "graph-created.json"
    if marker.exists():
        raise HTTPException(409, "Graph operation already attempted; create a new run")
    marker.write_text(json.dumps({"id": body.id, "state": "attempting"}), encoding="utf-8")
    client = zep()
    client.graph.create(graph_id=body.id, name=f"Social Simulation {body.id}")
    entities, edges = {}, {}
    for kind, target, parent in [("entityTypes", entities, EntityModel), ("relationTypes", edges, EdgeModel)]:
        for item in body.ontology.get(kind, [])[:10]:
            name = item.get("name", "")
            if not re.fullmatch(r"[A-Z][A-Za-z_]{0,39}", name):
                raise HTTPException(400, "Invalid ontology name")
            generated = type(name, (parent,), {"__doc__": item.get("description", name), "__annotations__": {}})
            target[name] = generated if kind == "entityTypes" else (generated, [])
    client.graph.set_ontology(graph_ids=[body.id], entities=entities, edges=edges or None)
    for document in body.documents:
        for index, text in enumerate(chunks(document.text)):
            episode = client.graph.add(graph_id=body.id, type="text", data=text,
                source_description=f"Original document {document.id}, chunk {index}",
                metadata={"origin": "source_document", "document_id": document.id, "chunk": index})
            wait_episode(client, episode)
    nodes = pages(client.graph.node.with_raw_response.get_by_graph_id, body.id)
    edges = pages(client.graph.edge.with_raw_response.get_by_graph_id, body.id)
    return {"id": body.id, "origin": "zep", "nodes": [{"id": n.uuid_, "name": n.name or "Unnamed",
        "summary": n.summary or "", "type": next((label for label in (n.labels or []) if label in entities), "Entity")}
        for n in nodes if any(label in entities for label in (n.labels or []))],
        "edges": [{"source": e.source_node_uuid, "target": e.target_node_uuid, "fact": e.fact or ""} for e in edges]}


@app.post("/graphs/{graph_id}/memory")
def memory(graph_id: str, body: MemoryRequest):
    folder = directory(graph_id)
    marker = folder / "memory-attempted.json"
    if marker.exists():
        raise HTTPException(409, "Memory ingestion already attempted; automatic replay is unsafe")
    marker.write_text(json.dumps({"count": len(body.actions)}), encoding="utf-8")
    client = zep()
    lines = [json.dumps(action, ensure_ascii=False) for action in body.actions]
    # One serialized event per line; explicit provenance survives graph extraction.
    for part in chunks("\n".join(lines), 6000):
        wait_episode(client, client.graph.add(graph_id=identifier(graph_id), type="text", data=part,
            source_description="Synthetic simulation events; not real-world facts",
            metadata={"origin": "simulation_event", "simulation_id": graph_id}))
    return {"ingested": len(lines)}


@app.post("/graphs/{graph_id}/search")
def search(graph_id: str, body: SearchRequest):
    result = zep().graph.search(graph_id=identifier(graph_id), query=body.query, scope="edges", limit=20)
    return {"facts": [{"id": edge.uuid_, "fact": edge.fact} for edge in (result.edges or [])]}


@app.post("/sessions")
async def start(body: SessionRequest):
    import oasis
    from oasis import ActionType, generate_twitter_agent_graph, generate_reddit_agent_graph
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    identifier(body.id)
    async with CREATION_LOCK:
        if body.id in SESSIONS or len(SESSIONS) >= 3:
            raise HTTPException(409, "Session exists or session capacity reached; close old sessions")
        folder = directory(body.id)
        if (folder / "session-attempted.json").exists():
            raise HTTPException(409, "Session was attempted before; create a new run")
        if [p.id for p in body.personas] != list(range(len(body.personas))):
            raise HTTPException(400, "Persona IDs must be sequential")
        config = body.config.model_dump()
        if len(set(config["platforms"])) != len(config["platforms"]):
            raise HTTPException(400, "Duplicate platform")
        if any(e["round"] >= config["rounds"] or e["agentId"] >= len(body.personas) for e in config["events"]):
            raise HTTPException(400, "Event outside simulation bounds")
        (folder / "session-attempted.json").write_text(body.model_dump_json(), encoding="utf-8")
        os.environ["OPENAI_API_BASE_URL"] = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        model = ModelFactory.create(model_platform=ModelPlatformType.OPENAI, model_type=os.getenv("OPENAI_MODEL", "gpt-4o-mini"))
        environments = {}
        try:
            for platform in config["platforms"]:
                profiles = [{"user_id": p.id, "username": f"agent_{p.id}", "name": p.name, "bio": p.bio,
                    "persona": p.persona, "karma": 1000, "friend_count": 10, "follower_count": 10,
                    "statuses_count": 0, "created_at": "2026-01-01"} for p in body.personas]
                profile_path = folder / f"{platform}.{'csv' if platform == 'twitter' else 'json'}"
                if platform == "twitter":
                    with profile_path.open("w", encoding="utf-8", newline="") as output:
                        writer = csv.DictWriter(output, fieldnames=list(profiles[0]))
                        writer.writeheader()
                        writer.writerows(profiles)
                    generate = generate_twitter_agent_graph
                    actions = [ActionType.CREATE_POST, ActionType.LIKE_POST, ActionType.REPOST, ActionType.FOLLOW, ActionType.DO_NOTHING, ActionType.QUOTE_POST]
                else:
                    profile_path.write_text(json.dumps(profiles, ensure_ascii=False), encoding="utf-8")
                    generate = generate_reddit_agent_graph
                    actions = [ActionType.CREATE_POST, ActionType.CREATE_COMMENT, ActionType.LIKE_POST, ActionType.DISLIKE_POST, ActionType.DO_NOTHING, ActionType.FOLLOW]
                graph = await generate(profile_path=str(profile_path), model=model, available_actions=actions)
                env = oasis.make(agent_graph=graph, platform=getattr(oasis.DefaultPlatformType, platform.upper()),
                    database_path=str(folder / f"{platform}.sqlite"), semaphore=4)
                environments[platform] = env
                await env.reset()
            SESSIONS[body.id] = {"environments": environments, "config": config,
                "personas": [p.model_dump() for p in body.personas], "round": 0, "rows": {}, "lock": asyncio.Lock(), "failed": False}
            return {"started": True}
        except BaseException:
            for env in environments.values():
                await env.close()
            raise


def session_for(session_id):
    session = SESSIONS.get(identifier(session_id))
    if not session:
        raise HTTPException(409, "OASIS session unavailable; it may have been closed or the bridge restarted")
    return session


def trace_rows(session_id, platform, after=0):
    with sqlite3.connect(directory(session_id) / f"{platform}.sqlite") as connection:
        return connection.execute("SELECT rowid,user_id,action,info FROM trace WHERE rowid>? ORDER BY rowid", (after,)).fetchall()


@app.post("/sessions/{session_id}/step")
async def step(session_id: str, body: RoundRequest):
    from oasis import ActionType, LLMAction, ManualAction
    session = session_for(session_id)
    async with session["lock"]:
        if session["failed"] or body.round != session["round"] or body.round >= session["config"]["rounds"]:
            raise HTTPException(409, "Round cannot be replayed or executed out of order")
        session["failed"] = True  # Remains poisoned after an ambiguous provider failure.
        result = []
        for platform, env in session["environments"].items():
            for _, event in events_for(session["config"], body.round):
                await env.step({env.agent_graph.get_agent(event["agentId"]): ManualAction(
                    action_type=ActionType.CREATE_POST, action_args={"content": event["content"]})})
            ids = active_ids(session["personas"], session["config"], body.round)
            if ids:
                await env.step({env.agent_graph.get_agent(agent_id): LLMAction() for agent_id in ids})
            rows = trace_rows(session_id, platform, session["rows"].get(platform, 0))
            for rowid, agent_id, action, info in rows:
                result.append({"id": f"{session_id}:{platform}:{rowid}", "round": body.round, "platform": platform,
                    "agentId": int(agent_id), "type": action, "content": str(info or ""), "origin": "simulation_event"})
                session["rows"][platform] = rowid
        session["round"] += 1
        session["failed"] = False
        return {"actions": result}


@app.post("/sessions/{session_id}/interview")
async def interview(session_id: str, body: InterviewRequest):
    from oasis import ActionType, ManualAction
    session = session_for(session_id)
    async with session["lock"]:
        if session["failed"] or session["round"] != session["config"]["rounds"]:
            raise HTTPException(409, "Complete simulation before interviewing")
        env = session["environments"].get(body.platform)
        if not env or body.agentId >= len(session["personas"]):
            raise HTTPException(404, "Agent/platform not found")
        await env.step({env.agent_graph.get_agent(body.agentId): ManualAction(
            action_type=ActionType.INTERVIEW, action_args={"prompt": body.question})})
        matching = [row for row in trace_rows(session_id, body.platform) if row[1] == body.agentId and row[2] == ActionType.INTERVIEW.value]
        if not matching:
            raise HTTPException(502, "OASIS did not persist an interview")
        info = json.loads(matching[-1][3])
        return {"answer": str(info.get("response", ""))}


@app.post("/sessions/{session_id}/close")
async def close(session_id: str):
    session = SESSIONS.get(identifier(session_id))
    if session:
        async with session["lock"]:
            for env in session["environments"].values():
                await env.close()
            SESSIONS.pop(session_id, None)
    return {"closed": True}
