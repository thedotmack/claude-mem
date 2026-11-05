/** The mounted personal editor owns its draft and decides whether it can be left. */
let leaveGuard: (() => boolean) | undefined

export function registerSkillLeaveGuard(guard: () => boolean): () => void {
  leaveGuard = guard
  return () => { if (leaveGuard === guard) leaveGuard = undefined }
}

export function canLeaveSkills(): boolean {
  return leaveGuard?.() ?? true
}
