import { BookOpenIcon, FileIcon, FileTextIcon, GitBranchIcon, GitCommitHorizontalIcon, GitPullRequestIcon, LinkIcon, PresentationIcon } from 'lucide-react'
import type { WorkProductKind } from '@/data'

/** One icon per kind of work product, shared by the request drawer and My Goals. */
export const PRODUCT_ICON: Record<WorkProductKind, typeof LinkIcon> = {
  PR: GitPullRequestIcon, Commit: GitCommitHorizontalIcon, Branch: GitBranchIcon, Page: FileTextIcon,
  Deck: PresentationIcon, Doc: BookOpenIcon, File: FileIcon, Link: LinkIcon,
}
