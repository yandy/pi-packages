export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. Allow this external directory access?`;
}

export function formatBashExternalDirectoryAskPrompt(
  command: string,
  externalPaths: string[],
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  const pathList = externalPaths.join(", ");
  return `${subject} requested bash command '${command}' which references path(s) outside working directory '${cwd}': ${pathList}. Allow this external directory access?`;
}
