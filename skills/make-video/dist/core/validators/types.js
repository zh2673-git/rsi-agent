export function err(id, message) {
    return { id, level: 'error', message };
}
export function warn(id, message) {
    return { id, level: 'warn', message };
}
export function hasError(issues) {
    return issues.some((i) => i.level === 'error');
}
export function formatIssues(issues) {
    return issues.map((i) => `[${i.level}] ${i.id}: ${i.message}`).join('\n');
}
