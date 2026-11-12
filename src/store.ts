import { DatabaseSync } from "node:sqlite";
import type { Project, Run } from "./domain.js";

export class Store {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));",
    );
    for (const run of this.runs()) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        run.error =
          "Processo reiniciado. Crie outra execução; operações externas não são repetidas automaticamente.";
        this.saveRun(run);
      }
    }
  }
  private put(kind: string, value: { id: string }) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  private list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((r) => JSON.parse(String(r.data)) as T);
  }
  saveProject(project: Project) {
    this.put("project", project);
  }
  project(id: string) {
    return this.get<Project>("project", id);
  }
  projects() {
    return this.list<Project>("project");
  }
  saveRun(run: Run) {
    run.updatedAt = new Date().toISOString();
    this.put("run", run);
  }
  run(id: string) {
    return this.get<Run>("run", id);
  }
  runs() {
    return this.list<Run>("run");
  }
  close() {
    this.db.close();
  }
}
