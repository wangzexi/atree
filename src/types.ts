export interface AtreeSessionMeta {
  id: string;
  title: string;
  icon?: string;
  schedule?: string;
  last_run_at?: string;
  next_run_at?: string;
  updated_at: string;
}

export interface AtreeConfig {
  version: 1;
  title: string;
  sessions: AtreeSessionMeta[];
}

export interface AtreeNode {
  id: string;
  name: string;
  path: string;
  title: string;
  sessions: AtreeSessionMeta[];
  children: AtreeNode[];
}

export interface DisplayMessage {
  id: string;
  role: string;
  text: string;
  timestamp?: number;
}
