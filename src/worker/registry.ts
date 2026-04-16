import type { WorkerAdapter, WorkerRegistry } from "./adapter.js";

class InProcessWorkerRegistry implements WorkerRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();

  register(adapter: WorkerAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Worker adapter already registered: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  get(adapterName: string): WorkerAdapter {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      const known = [...this.adapters.keys()].join(", ") || "(none)";
      throw new Error(
        `Worker adapter not found: "${adapterName}". Registered: ${known}`
      );
    }
    return adapter;
  }
}

export function createWorkerRegistry(): WorkerRegistry {
  return new InProcessWorkerRegistry();
}
