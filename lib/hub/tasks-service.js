export const TASKS_SERVICE = 'remote-agent:tasks'

/** Read-only access to the registry's existing sanitized task projections. */
export function createHubTasksService({ registry, log = () => {} } = {}) {
  let warned = false

  function available(...methods) {
    if (methods.every(method => typeof registry?.[method] === 'function')) return true
    if (!warned) {
      warned = true
      try {
        log('warn', `${TASKS_SERVICE} registry methods unavailable`)
      } catch {
        // Logging must not turn a missing optional registry into a failure.
      }
    }
    return false
  }

  return {
    listTasks() {
      if (!available('listTasks', 'taskView')) return []
      return registry.listTasks()
        .map(task => registry.taskView(task))
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    },
    getTask(taskId) {
      if (!available('getTask', 'taskView')) return undefined
      const task = registry.getTask(taskId)
      return task == null ? undefined : registry.taskView(task)
    },
    taskView(task) {
      if (!available('taskView') || task == null) return undefined
      return registry.taskView(task)
    },
    dispose() {
      registry = undefined
    },
  }
}
