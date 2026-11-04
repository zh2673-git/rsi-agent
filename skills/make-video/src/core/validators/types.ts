export type IssueLevel = 'error' | 'warn';

export interface Issue {
  id: string;
  level: IssueLevel;
  message: string;
}

export function err(id: string, message: string): Issue {
  return { id, level: 'error', message };
}

export function warn(id: string, message: string): Issue {
  return { id, level: 'warn', message };
}

export function hasError(issues: Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `[${i.level}] ${i.id}: ${i.message}`).join('\n');
}
