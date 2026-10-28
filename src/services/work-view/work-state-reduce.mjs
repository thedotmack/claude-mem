// Work-state rows replayed into lists, tasks and events. Shared by the data source (data-source.mjs) and My Focus
// (my-focus.mjs), which must not import each other.
const CLOSED = new Set(['done', 'dropped']);
const normalizedKey = (value) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const iso = (epoch) => epoch == null ? null : new Date(epoch).toISOString();
const isClosed = (status) => status != null && CLOSED.has(String(status).toLowerCase());
const effectiveStatus = (status) => status == null || status === '' ? 'unknown' : String(status).toLowerCase();
const listId = (project, name) => JSON.stringify([normalizedKey(project), name]);
const taskId = (parentId, name) => JSON.stringify([parentId, name]);

// Entries are patches, not full records. This is the same append/merge behavior
// as claude-mem's WorkStateRenderer: state and named tasks are separate maps.
export function reduceWorkState(entries, { currentProject, currentProjectScope = [], eventLimit = Infinity, localDeviceId = '' } = {}) {
  const scope = new Set(currentProjectScope.map(normalizedKey));
  const listsById = new Map();
  const events = [];
  let revision = 0;
  // Match sqlite/work-state.ts:getWorkStateEntries. Imported rows replay at
  // their original write time, not the later local rowid assigned on arrival.
  const device = row => row.origin_device_id ?? localDeviceId;
  for (const row of [...entries].sort((a, b) => {
    const timeAndDevice = a.created_at_epoch - b.created_at_epoch
      || (device(a) < device(b) ? -1 : device(a) > device(b) ? 1 : 0);
    if (timeAndDevice) return timeAndDevice;
    const left = BigInt(a.origin_local_id ?? a.id), right = BigInt(b.origin_local_id ?? b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    revision = Math.max(revision, row.id);
    const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid work-state entry');
    const id = listId(row.scope_project ?? row.project, row.list_name);
    let list = listsById.get(id);
    if (!list) {
      list = { id, project: row.scope_project ?? row.project, name: row.list_name, fields: {}, tasksByName: new Map(), updatedAtEpoch: 0, stateUpdatedAtEpoch: null, latestEntryId: 0 };
      listsById.set(id, list);
    }
    const taskName = fields.task == null || fields.task === '' ? null : String(fields.task);
    let target = list;
    if (taskName !== null) {
      target = list.tasksByName.get(taskName);
      if (!target) {
        target = { id: taskId(id, taskName), name: taskName, fields: {}, updatedAtEpoch: 0, latestEntryId: 0 };
        list.tasksByName.set(taskName, target);
      }
    } else {
      list.stateUpdatedAtEpoch = row.created_at_epoch;
    }
    const changes = [];
    for (const [key, value] of Object.entries(fields)) {
      const hadPrevious = Object.hasOwn(target.fields, key);
      const previous = target.fields[key];
      if (key !== 'task' && ((value === null && hadPrevious) || (value !== null && (!hadPrevious || previous !== value)))) {
        changes.push({ field: key, ...(hadPrevious ? { previous } : {}), value, hadPrevious });
      }
      if (value === null) delete target.fields[key];
      else target.fields[key] = value;
    }
    target.updatedAtEpoch = row.created_at_epoch;
    target.latestEntryId = row.id;
    list.updatedAtEpoch = row.created_at_epoch;
    list.latestEntryId = row.id;
    events.push({
      id: row.id, project: list.project, originProject: row.project, listName: row.list_name, listId: id,
      task: taskName, taskId: taskName === null ? null : target.id,
      type: taskName === null ? 'state' : 'task', fields, changes,
      status: taskName === null ? (target.fields.status == null ? 'open' : String(target.fields.status).toLowerCase()) : effectiveStatus(target.fields.status),
      at: iso(row.created_at_epoch), atEpoch: row.created_at_epoch,
      sourceOrder: [row.created_at_epoch, device(row), String(row.origin_local_id ?? row.id)],
      inCurrentScope: scope.has(normalizedKey(row.project)),
    });
  }
  const lists = [...listsById.values()].sort((a, b) => b.latestEntryId - a.latestEntryId).map((list) => {
    const tasks = [...list.tasksByName.values()].map((task) => ({
      ...task, status: effectiveStatus(task.fields.status), isOpen: !isClosed(task.fields.status), updatedAt: iso(task.updatedAtEpoch),
    }));
    const stateIsOpen = Object.keys(list.fields).some((key) => key !== 'task') && !isClosed(list.fields.status);
    const { tasksByName, ...record } = list;
    return {
      ...record, status: isClosed(list.fields.status) ? String(list.fields.status).toLowerCase() : 'open',
      isOpen: stateIsOpen || tasks.some((task) => task.isOpen),
      inCurrentScope: scope.has(normalizedKey(list.project)),
      updatedAt: iso(list.updatedAtEpoch), stateUpdatedAt: iso(list.stateUpdatedAtEpoch), tasks,
    };
  });
  const projectsById = new Map();
  for (const list of lists) {
    const key = normalizedKey(list.project);
    const project = projectsById.get(key) ?? { id: list.project, name: list.project, lists: 0, openLists: 0, tasks: 0, doing: 0, inCurrentScope: list.inCurrentScope, lastUpdatedAt: list.updatedAt };
    project.lists++;
    project.openLists += Number(list.isOpen);
    project.tasks += list.tasks.length;
    project.doing += list.tasks.filter((task) => task.isOpen && task.status === 'doing').length;
    projectsById.set(key, project);
  }
  const projects = [...projectsById.values()];
  const tasks = lists.flatMap((list) => list.tasks);
  const summary = {
    projects: projects.length, lists: lists.length, openLists: lists.filter((list) => list.isOpen).length,
    tasks: tasks.length, openTasks: tasks.filter((task) => task.isOpen).length,
    todo: tasks.filter((task) => task.status === 'todo').length,
    doing: tasks.filter((task) => task.status === 'doing').length,
    done: tasks.filter((task) => task.status === 'done').length,
    dropped: tasks.filter((task) => task.status === 'dropped').length,
    unknown: tasks.filter((task) => task.status === 'unknown').length,
  };
  return {
    schemaVersion: 1, revision,
    entryCount: entries.length, currentProject, currentProjectScope, summary, projects, lists,
    events: events.slice(-eventLimit).reverse(),
    lastUpdatedAt: events.length ? events.at(-1).at : null,
  };
}

