export interface AtreeSessionMeta {
  id: string;
  title: string;
  icon?: string;
  schedule?: string;
  last_run_at?: string;
  next_run_at?: string;
  updated_at: string;
  archived?: boolean;
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
