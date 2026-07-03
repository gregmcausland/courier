export type AgentSessionRef = { agent?: string; kind?: string; source?: string; value?: string };
export type Pane = { pane_id: string; terminal_id?: string; workspace_id?: string; tab_id?: string; focused?: boolean; agent_status?: string; agent_session?: AgentSessionRef; label?: string; agent?: string };
export type WorkerType = "triage";
export type AgentRecord = { name: string; terminalId: string; paneId: string; agent: string; type?: WorkerType; agentSession?: AgentSessionRef; createdAt: string; closedAt?: string };
export type State = { version: 1; agents: Record<string, AgentRecord>; watches: Record<string, string[]> };
export type Delivery = { id: string; to: string; from: string; text: string; message?: string; createdAt: string };
export type CreateOptions = { name: string; from?: string; tab: boolean; here?: boolean; tail: string[]; agent: string; type?: WorkerType };
export type CreateResult = { name: string; terminalId: string; paneId: string; agent: string; type?: WorkerType; agentSession?: AgentSessionRef };
