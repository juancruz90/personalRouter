const DEFAULT_READ_ONLY_PROJECTS = ['reel'];

export class ProjectWriteLockedError extends Error {
  public readonly project: string;

  constructor(project: string) {
    super(`Project '${project}' is locked in read-only mode`);
    this.name = 'ProjectWriteLockedError';
    this.project = project;
  }
}

function normalizeProject(value: string): string {
  return value.trim().toLowerCase();
}

export function parseReadOnlyProjects(raw?: string): Set<string> {
  const source = raw ?? process.env.READ_ONLY_PROJECTS ?? DEFAULT_READ_ONLY_PROJECTS.join(',');

  return new Set(
    source
      .split(',')
      .map((value) => normalizeProject(value))
      .filter(Boolean),
  );
}

export function isProjectReadOnly(project: string, readOnlyProjects = parseReadOnlyProjects()): boolean {
  return readOnlyProjects.has(normalizeProject(project));
}

export function assertProjectWritable(project: string, readOnlyProjects = parseReadOnlyProjects()): void {
  if (isProjectReadOnly(project, readOnlyProjects)) {
    throw new ProjectWriteLockedError(project);
  }
}

export function projectAccess(project: string, readOnlyProjects = parseReadOnlyProjects()) {
  const readOnly = isProjectReadOnly(project, readOnlyProjects);

  return {
    project,
    mode: readOnly ? 'read-only' : 'read-write',
    writable: !readOnly,
  };
}
