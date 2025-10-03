import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  TransitionChild,
} from '@headlessui/react';
import {
  Bars3Icon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import OverviewCard from './src/components/OverviewCard';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function MemoryStream() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overviewsOpen, setOverviewsOpen] = useState(false);
  const [memories, setMemories] = useState([]);
  const [overviews, setOverviews] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [connected, setConnected] = useState(false);
  const [selectedProject, setSelectedProject] = useState('all');
  const [selectedTag, setSelectedTag] = useState(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAwaitingOverview, setIsAwaitingOverview] = useState(false);
  const [debugOverviewCard, setDebugOverviewCard] = useState(false);
  const eventSourceRef = useRef(null);

  let filteredMemories = selectedProject === 'all'
    ? memories
    : memories.filter(m => m.project === selectedProject);

  if (selectedTag) {
    filteredMemories = filteredMemories.filter(m => m.concepts?.includes(selectedTag));
  }

  const filteredOverviews = selectedProject === 'all'
    ? overviews
    : overviews.filter(o => o.project === selectedProject);

  const existingCount = filteredMemories.filter(m => !m.isNew).length;
  const newCount = filteredMemories.filter(m => m.isNew).length;

  const stats = {
    total: filteredMemories.length,
    new: newCount,
    existing: existingCount,
    sessions: new Set(filteredMemories.map(m => m.session_id)).size,
    projects: new Set(memories.map(m => m.project)).size
  };

  const projects = ['all', ...new Set(memories.map(m => m.project).filter(Boolean))];

  useEffect(() => {
    setStatus('connecting');
    const eventSource = new EventSource('http://localhost:3001/stream');
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setStatus('connected');
      setConnected(true);
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'initial_load') {
        const existingMemories = data.memories.map(m => ({ ...m, isNew: false }));
        setMemories(existingMemories);
        const existingOverviews = data.overviews.map(o => ({ ...o, isNew: false }));
        setOverviews(existingOverviews);
        setInitialLoadComplete(true);
        setCurrentIndex(0);
      } else if (data.type === 'new_memories') {
        const newMemories = data.memories.map(m => ({ ...m, isNew: true }));
        setMemories(prev => [...newMemories, ...prev]);
        setCurrentIndex(0);
      } else if (data.type === 'new_overviews') {
        const newOverviews = data.overviews.map(o => ({ ...o, isNew: true }));
        // Remove placeholders for the same projects as the incoming real overviews
        const incomingProjects = new Set(newOverviews.map(o => o.project));
        setOverviews(prev => {
          const withoutPlaceholders = prev.filter(o =>
            !o.isPlaceholder || !incomingProjects.has(o.project)
          );
          return [...newOverviews, ...withoutPlaceholders];
        });
        setIsAwaitingOverview(false);
      } else if (data.type === 'session_start') {
        // Only process for current project (or 'all')
        if (selectedProject === 'all' || data.project === selectedProject) {
          setIsProcessing(true);
          setIsAwaitingOverview(true);

          // Create placeholder overview card
          const placeholderOverview = {
            id: `placeholder-${Date.now()}`,
            project: data.project,
            content: '⏳ Session in progress...',
            created_at: new Date().toISOString(),
            session_id: null,
            isNew: true,
            isPlaceholder: true
          };
          setOverviews(prev => [placeholderOverview, ...prev]);
        }
      } else if (data.type === 'session_end') {
        // Only process for current project (or 'all')
        if (selectedProject === 'all' || data.project === selectedProject) {
          setIsProcessing(false);
          setIsAwaitingOverview(false);
        }
      }
    };

    eventSource.onerror = () => {
      setStatus('reconnecting');
      setConnected(false);
      eventSource.close();
      setTimeout(() => window.location.reload(), 2000);
    };

    return () => eventSource.close();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentIndex(i => (i - 1 + filteredMemories.length) % filteredMemories.length);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentIndex(i => (i + 1) % filteredMemories.length);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredMemories.length]);

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    const diff = Date.now() - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const memory = filteredMemories[currentIndex] || {};

  // Extract unique tags from all memories
  const allTags = [...new Set(memories.flatMap(m => m.concepts || []))];
  const tagCounts = allTags.reduce((acc, tag) => {
    acc[tag] = memories.filter(m => m.concepts?.includes(tag)).length;
    return acc;
  }, {});
  const sortedTags = allTags.sort((a, b) => tagCounts[b] - tagCounts[a]);

  return (
    <>
      <div className="min-h-screen bg-black text-gray-100 relative overflow-hidden">
        {/* Background Effects */}
        <div className="fixed inset-0 opacity-20">
          <div className="absolute inset-0" style={{
            backgroundImage: 'linear-gradient(rgba(59, 130, 246, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(59, 130, 246, 0.1) 1px, transparent 1px)',
            backgroundSize: '50px 50px'
          }} />
        </div>

        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 w-full h-full" style={{
            background: 'radial-gradient(ellipse at 20% 30%, rgba(59, 130, 246, 0.15) 0%, transparent 50%)'
          }} />
          <div className="absolute top-0 right-0 w-full h-full" style={{
            background: 'radial-gradient(ellipse at 80% 20%, rgba(139, 92, 246, 0.15) 0%, transparent 50%)'
          }} />
          <div className="absolute bottom-0 left-1/2 w-full h-full" style={{
            background: 'radial-gradient(ellipse at 50% 80%, rgba(16, 185, 129, 0.1) 0%, transparent 50%)'
          }} />
        </div>

        {/* Mobile sidebar */}
        <Dialog open={sidebarOpen} onClose={setSidebarOpen} className="relative z-50 xl:hidden">
          <DialogBackdrop
            transition
            className="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
          />

          <div className="fixed inset-0 flex">
            <DialogPanel
              transition
              className="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
            >
              <TransitionChild>
                <div className="absolute left-full top-0 flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
                  <button type="button" onClick={() => setSidebarOpen(false)} className="-m-2.5 p-2.5">
                    <span className="sr-only">Close sidebar</span>
                    <XMarkIcon aria-hidden="true" className="size-6 text-white" />
                  </button>
                </div>
              </TransitionChild>

              <div className="relative flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900/90 backdrop-blur-xl px-6 border-r border-gray-800">
                <div className="relative flex h-16 shrink-0 items-center">
                  <img src="/claude-mem-logo.webp" alt="claude-mem" className="h-10 w-auto" />
                </div>
                <nav className="relative flex flex-1 flex-col">
                  <div className="space-y-6">
                    <div className="relative">
                      <div className="absolute -inset-2 bg-gradient-to-r from-blue-600/10 via-purple-600/10 to-emerald-600/10 rounded-xl blur-xl" />
                      <div className="relative bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
                        <h3 className="text-xs font-bold text-blue-400 mb-3 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                          STATISTICS
                        </h3>
                        <div className="space-y-2.5">
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-400">Total</span>
                            <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-blue-500">{stats.total}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-400">New</span>
                            <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 to-emerald-500">{stats.new}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-400">Sessions</span>
                            <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-purple-500">{stats.sessions}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-400">Projects</span>
                            <span className="text-lg font-bold text-gray-300">{stats.projects}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="relative">
                      <div className="absolute -inset-2 bg-gradient-to-r from-purple-600/10 via-blue-600/10 to-purple-600/10 rounded-xl blur-xl" />
                      <div className="relative bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
                        <h3 className="text-xs font-bold text-purple-400 mb-3 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                          TAG CLOUD
                        </h3>
                        <div className="flex flex-wrap gap-2">
                          {sortedTags.slice(0, 20).map((tag) => (
                            <span
                              key={tag}
                              onClick={() => {
                                setSelectedTag(selectedTag === tag ? null : tag);
                                setCurrentIndex(0);
                              }}
                              className={classNames(
                                "px-2.5 py-1 rounded-lg border text-xs font-medium transition-all cursor-pointer",
                                selectedTag === tag
                                  ? "bg-purple-500/30 border-purple-400/60 text-purple-200 shadow-lg shadow-purple-500/20"
                                  : "bg-purple-500/10 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
                              )}
                            >
                              {tag} ({tagCounts[tag]})
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </nav>
              </div>
            </DialogPanel>
          </div>
        </Dialog>

        {/* Desktop sidebar */}
        <div className="hidden xl:fixed xl:inset-y-0 xl:z-50 xl:flex xl:w-80 xl:flex-col">
          <div className="relative flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900/90 backdrop-blur-xl px-6 border-r border-gray-800">
            <div className="flex h-16 shrink-0 items-center">
              <img src="/claude-mem-logo.webp" alt="claude-mem" className="h-10 w-auto" />
            </div>
            <nav className="flex flex-1 flex-col">
              <div className="space-y-6">
                <div className="relative">
                  <div className="absolute -inset-2 bg-gradient-to-r from-blue-600/10 via-purple-600/10 to-emerald-600/10 rounded-xl blur-xl" />
                  <div className="relative bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
                    <h3 className="text-xs font-bold text-blue-400 mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      STATISTICS
                    </h3>
                    <div className="space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-400">Total</span>
                        <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-blue-500">{stats.total}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-400">New</span>
                        <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 to-emerald-500">{stats.new}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-400">Sessions</span>
                        <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-purple-500">{stats.sessions}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-400">Projects</span>
                        <span className="text-lg font-bold text-gray-300">{stats.projects}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="relative">
                  <div className="absolute -inset-2 bg-gradient-to-r from-purple-600/10 via-blue-600/10 to-purple-600/10 rounded-xl blur-xl" />
                  <div className="relative bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
                    <h3 className="text-xs font-bold text-purple-400 mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                      TAG CLOUD
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {sortedTags.slice(0, 20).map((tag) => (
                        <span
                          key={tag}
                          onClick={() => {
                            setSelectedTag(selectedTag === tag ? null : tag);
                            setCurrentIndex(0);
                          }}
                          className={classNames(
                            "px-2.5 py-1 rounded-lg border text-xs font-medium transition-all cursor-pointer",
                            selectedTag === tag
                              ? "bg-purple-500/30 border-purple-400/60 text-purple-200 shadow-lg shadow-purple-500/20"
                              : "bg-purple-500/10 border-purple-400/30 text-purple-300 hover:bg-purple-500/20"
                          )}
                        >
                          {tag} ({tagCounts[tag]})
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </nav>
          </div>
        </div>

        <div className="xl:pl-80">
          {/* Fixed search header */}
          <div className="fixed top-0 left-0 right-0 xl:left-80 z-40 flex h-16 shrink-0 items-center gap-x-6 border-b border-gray-800 bg-gray-900/90 backdrop-blur-xl px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="-m-2.5 p-2.5 text-gray-300 xl:hidden hover:text-white transition-colors"
            >
              <span className="sr-only">Open sidebar</span>
              <Bars3Icon aria-hidden="true" className="size-5" />
            </button>

            <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
              <form action="#" method="GET" className="grid flex-1 grid-cols-1 relative">
                <input
                  name="search"
                  placeholder="Search memories..."
                  aria-label="Search"
                  className="col-start-1 row-start-1 block size-full bg-gray-800/50 rounded-lg pl-10 pr-4 text-base text-gray-100 border border-gray-700 focus:border-blue-500/50 outline-none placeholder:text-gray-500 sm:text-sm/6 transition-colors"
                />
                <MagnifyingGlassIcon
                  aria-hidden="true"
                  className="pointer-events-none col-start-1 row-start-1 size-5 self-center ml-3 text-gray-500"
                />
              </form>
            </div>

            <div className="flex items-center gap-3">
              {connected && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-purple-500/20 to-blue-500/20 border border-purple-400/30">
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse shadow-lg shadow-purple-400/50" />
                  <span className="text-xs font-bold text-purple-300 tracking-wide">LIVE</span>
                </div>
              )}

              <button
                onClick={() => setDebugOverviewCard(!debugOverviewCard)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                  debugOverviewCard
                    ? 'bg-gradient-to-r from-blue-500/30 to-purple-500/30 border border-blue-400/60 text-blue-300'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-400 hover:border-gray-600'
                }`}
              >
                DEBUG
              </button>
            </div>

            <button
              type="button"
              onClick={() => setOverviewsOpen(true)}
              className="-m-2.5 p-2.5 text-gray-300 xl:hidden hover:text-white transition-colors"
            >
              <span className="sr-only">Open overviews</span>
              <Bars3Icon aria-hidden="true" className="size-5" />
            </button>
          </div>

          <main className="pt-16">
            {/* Activity Indicator Bar */}
            <div className="h-1 fixed top-16 left-0 right-0 xl:left-80 z-30" style={{
              background: 'linear-gradient(90deg, transparent, #3b82f6, #8b5cf6, #10b981, transparent)',
              animation: isProcessing ? 'scan 3s ease-in-out infinite' : 'none',
              opacity: isProcessing ? 1 : 0,
              boxShadow: isProcessing ? '0 0 20px rgba(59, 130, 246, 0.8)' : 'none'
            }} />

            {/* Debug Overview Card Mode */}
            {debugOverviewCard && (
              <OverviewCard debugMode={true} initialState="empty" />
            )}

            {/* Normal Memory Stream View */}
            {!debugOverviewCard && (
            <div className="px-4 sm:px-6 lg:px-8 py-6">
              {!connected && (
                <div className="max-w-3xl mx-auto mb-12">
                  <div className="relative group">
                    <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 via-purple-600 to-emerald-600 rounded-2xl blur opacity-25 animate-pulse" />
                    <div className="relative bg-gray-900/90 backdrop-blur-xl rounded-2xl p-8 border border-gray-800">
                      <div className="text-center">
                        <div className="relative inline-block mb-4">
                          <div className="absolute inset-0 bg-blue-500/20 blur-3xl animate-pulse" />
                          <div className="relative text-6xl">📡</div>
                        </div>
                        <h2 className="text-2xl font-bold mb-2 bg-gradient-to-r from-blue-300 to-purple-300 bg-clip-text text-transparent">
                          {status === 'connecting' ? 'Connecting to Memory Stream' : 'Reconnecting...'}
                        </h2>
                        <p className="text-gray-400">~/.claude-mem/claude-mem.db</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {connected && filteredMemories.length === 0 && (
                <div className="max-w-4xl mx-auto text-center py-20">
                  <div className="relative inline-block">
                    <div className="absolute inset-0 bg-purple-500/20 blur-3xl animate-pulse" />
                    <div className="relative text-6xl mb-4">💭</div>
                  </div>
                  <h3 className="text-2xl font-bold text-gray-300 mb-2">No Memories Found</h3>
                  <p className="text-gray-500">
                    {selectedProject === 'all'
                      ? 'No memories with titles in database'
                      : `No memories for project: ${selectedProject}`}
                  </p>
                </div>
              )}

              {filteredMemories.length > 0 && (
                <div className="mb-8 max-w-6xl mx-auto relative z-50">
                  <div className="flex items-center gap-4">
                    <select
                      value={selectedProject}
                      onChange={(e) => {
                        setSelectedProject(e.target.value);
                        setCurrentIndex(0);
                      }}
                      className="px-4 py-2 rounded-lg bg-gray-800/50 border border-gray-700 text-gray-300 font-mono text-sm cursor-pointer hover:border-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                    >
                      {projects.map(project => (
                        <option key={project} value={project}>
                          {project === 'all' ? 'All Projects' : project}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={() => setCurrentIndex(i => (i - 1 + filteredMemories.length) % filteredMemories.length)}
                      className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-blue-400/30 hover:border-blue-400/60 flex items-center justify-center transition-all duration-300 hover:scale-110 group"
                    >
                      <span className="text-blue-300 text-lg group-hover:text-blue-200">←</span>
                    </button>

                    <div className="flex items-center gap-3 flex-1">
                      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 via-purple-500 to-emerald-500 transition-all duration-300"
                          style={{ width: `${((currentIndex + 1) / filteredMemories.length) * 100}%` }}
                        />
                      </div>
                      <div className="text-sm font-mono text-gray-500 min-w-[80px] text-center">
                        {currentIndex + 1} / {filteredMemories.length}
                      </div>
                    </div>

                    <button
                      onClick={() => setCurrentIndex(i => (i + 1) % filteredMemories.length)}
                      className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-600/20 to-blue-600/20 border border-purple-400/30 hover:border-purple-400/60 flex items-center justify-center transition-all duration-300 hover:scale-110 group"
                    >
                      <span className="text-purple-300 text-lg group-hover:text-purple-200">→</span>
                    </button>
                  </div>
                </div>
              )}

              {filteredMemories.length > 0 && (
                <div className="max-w-6xl mx-auto">
                  <div key={memory.id} className="relative" style={{
                    animation: 'slideIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
                  }}>
                    <div className="absolute -inset-4 bg-gradient-to-r from-blue-600/20 via-purple-600/20 to-emerald-600/20 rounded-3xl blur-2xl" />

                    <div className="relative bg-gradient-to-br from-gray-900/90 to-gray-950/90 backdrop-blur-xl rounded-3xl p-12 border border-gray-800">
                      <div className="mb-8">
                        <div className="flex items-center gap-3 mb-4 flex-wrap">
                          <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-gradient-to-r from-blue-500/20 to-blue-500/10 border border-blue-400/30 text-blue-300">
                            #{memory.id}
                          </span>
                          <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-gradient-to-r from-purple-500/20 to-purple-500/10 border border-purple-400/30 text-purple-300">
                            {memory.project}
                          </span>
                          {memory.origin && (
                            <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-gradient-to-r from-emerald-500/20 to-emerald-500/10 border border-emerald-400/30 text-emerald-300">
                              {memory.origin}
                            </span>
                          )}
                          <span className="ml-auto text-xs font-mono text-gray-500">
                            {formatTimestamp(memory.created_at)}
                          </span>
                        </div>

                        <h1 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-300 via-purple-300 to-emerald-300 mb-4 leading-tight">
                          {memory.title}
                        </h1>

                        {memory.subtitle && (
                          <p className="text-xl text-gray-400 leading-relaxed">
                            {memory.subtitle}
                          </p>
                        )}
                      </div>

                      {memory.facts?.length > 0 && (
                        <div className="mb-8">
                          <h3 className="text-sm font-bold text-blue-400 mb-4 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                            FACTS EXTRACTED
                          </h3>
                          <div className="space-y-3">
                            {memory.facts.map((fact, i) => (
                              <div key={i} className="flex gap-3 text-gray-300 leading-relaxed" style={{
                                animation: 'fadeInUp 0.5s ease-out',
                                animationDelay: `${i * 0.1}s`,
                                animationFillMode: 'both'
                              }}>
                                <span className="text-blue-400 font-mono text-xs mt-1">▸</span>
                                <span>{fact}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {memory.concepts?.length > 0 && (
                        <div className="mb-8">
                          <h3 className="text-sm font-bold text-purple-400 mb-4 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                            CONCEPTS
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            {memory.concepts.map((concept, i) => (
                              <span key={i} className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-400/30 text-purple-300 text-sm font-medium" style={{
                                animation: 'fadeInUp 0.5s ease-out',
                                animationDelay: `${i * 0.05}s`,
                                animationFillMode: 'both'
                              }}>
                                {concept}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {memory.files_touched?.length > 0 && (
                        <div>
                          <h3 className="text-sm font-bold text-emerald-400 mb-4 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            FILES TOUCHED
                          </h3>
                          <div className="space-y-2">
                            {memory.files_touched.map((file, i) => (
                              <div key={i} className="flex items-center gap-2 text-sm font-mono text-emerald-300/80" style={{
                                animation: 'fadeInUp 0.5s ease-out',
                                animationDelay: `${i * 0.1}s`,
                                animationFillMode: 'both'
                              }}>
                                <span>📄</span>
                                <span>{file}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-8 pt-6 border-t border-gray-800 flex items-center justify-between">
                        <div className="text-xs font-mono text-gray-600">
                          session: {memory.session_id?.substring(0, 8)}...{memory.session_id?.slice(-4)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 text-center text-xs text-gray-600">
                    <p>← → arrow keys to navigate</p>
                  </div>
                </div>
              )}
            </div>
            )}
          </main>

          {/* Mobile overviews drawer */}
          <Dialog open={overviewsOpen} onClose={setOverviewsOpen} className="relative z-50 xl:hidden">
            <DialogBackdrop
              transition
              className="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
            />

            <div className="fixed inset-0 flex justify-end">
              <DialogPanel
                transition
                className="relative ml-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:translate-x-full"
              >
                <TransitionChild>
                  <div className="absolute right-full top-0 flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
                    <button type="button" onClick={() => setOverviewsOpen(false)} className="-m-2.5 p-2.5">
                      <span className="sr-only">Close overviews</span>
                      <XMarkIcon aria-hidden="true" className="size-6 text-white" />
                    </button>
                  </div>
                </TransitionChild>

                <div className="relative flex grow flex-col overflow-y-auto bg-gray-900/90 backdrop-blur-xl border-l border-gray-800">
                  <header className="flex items-center justify-between border-b border-gray-800 px-4 py-4 sm:px-6">
                    <h2 className="text-base/7 font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-purple-300">Session Overviews</h2>
                    <span className="text-sm font-mono text-gray-500">{filteredOverviews.length}</span>
                  </header>
                  <ul role="list" className="divide-y divide-gray-800">
                    {filteredOverviews.length === 0 && (
                      <li className="px-4 py-12 text-center">
                        <div className="relative inline-block">
                          <div className="absolute inset-0 bg-purple-500/10 blur-2xl" />
                          <div className="relative text-4xl mb-3 opacity-50">📋</div>
                        </div>
                        <p className="text-sm text-gray-500">No overviews yet</p>
                      </li>
                    )}

                    {filteredOverviews.map((overview) => (
                      <li key={overview.id} className="px-4 py-4 sm:px-6 hover:bg-gray-800/30 transition-colors">
                        <div className="flex items-start gap-3 mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-500/10 border border-purple-400/30 text-purple-300">
                                #{overview.id}
                              </span>
                              {overview.isNew && (
                                <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-500/20 border border-blue-400/40 text-blue-300 animate-pulse">
                                  NEW
                                </span>
                              )}
                            </div>
                            <div className="text-xs font-mono text-gray-500 truncate">
                              {overview.project}
                            </div>
                          </div>
                          <div className="text-xs text-gray-500">
                            {formatTimestamp(overview.created_at)}
                          </div>
                        </div>

                        {overview.promptTitle && (
                          <div className="mb-3">
                            <h3 className="text-sm font-bold text-blue-300 mb-1 leading-snug">
                              {overview.promptTitle}
                            </h3>
                            {overview.promptSubtitle && (
                              <p className="text-xs text-gray-400 leading-relaxed">
                                {overview.promptSubtitle}
                              </p>
                            )}
                          </div>
                        )}

                        <p className="text-sm text-gray-300 leading-relaxed line-clamp-6">
                          {overview.content}
                        </p>

                        <div className="mt-2 pt-2 border-t border-gray-800">
                          <div className="text-xs font-mono text-gray-600 truncate">
                            session: {overview.session_id?.substring(0, 8)}...{overview.session_id?.slice(-4)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </DialogPanel>
            </div>
          </Dialog>

          {/* Desktop overviews sidebar */}
          <aside className="hidden xl:block bg-gray-900/90 backdrop-blur-xl xl:fixed xl:bottom-0 xl:right-0 xl:top-16 xl:w-96 xl:overflow-y-auto xl:border-l xl:border-gray-800">
            <header className="flex items-center justify-between border-b border-gray-800 px-4 py-4 sm:px-6 lg:px-8">
              <h2 className="text-base/7 font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-purple-300">Session Overviews</h2>
              <span className="text-sm font-mono text-gray-500">{filteredOverviews.length}</span>
            </header>
            <ul role="list" className="divide-y divide-gray-800">
              {filteredOverviews.length === 0 && (
                <li className="px-4 py-12 text-center">
                  <div className="relative inline-block">
                    <div className="absolute inset-0 bg-purple-500/10 blur-2xl" />
                    <div className="relative text-4xl mb-3 opacity-50">📋</div>
                  </div>
                  <p className="text-sm text-gray-500">No overviews yet</p>
                </li>
              )}

              {filteredOverviews.map((overview) => (
                <li key={overview.id} className="px-4 py-4 sm:px-6 lg:px-8 hover:bg-gray-800/30 transition-colors">
                  <div className="flex items-start gap-3 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-500/10 border border-purple-400/30 text-purple-300">
                          #{overview.id}
                        </span>
                        {overview.isNew && (
                          <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-500/20 border border-blue-400/40 text-blue-300 animate-pulse">
                            NEW
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-gray-500 truncate">
                        {overview.project}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatTimestamp(overview.created_at)}
                    </div>
                  </div>

                  {overview.promptTitle && (
                    <div className="mb-3">
                      <h3 className="text-sm font-bold text-blue-300 mb-1 leading-snug">
                        {overview.promptTitle}
                      </h3>
                      {overview.promptSubtitle && (
                        <p className="text-xs text-gray-400 leading-relaxed">
                          {overview.promptSubtitle}
                        </p>
                      )}
                    </div>
                  )}

                  <p className="text-sm text-gray-300 leading-relaxed line-clamp-6">
                    {overview.content}
                  </p>

                  <div className="mt-2 pt-2 border-t border-gray-800">
                    <div className="text-xs font-mono text-gray-600 truncate">
                      session: {overview.session_id?.substring(0, 8)}...{overview.session_id?.slice(-4)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>

      <style>{`
        @keyframes scan {
          0%, 100% {
            transform: translateX(-100%);
            opacity: 0;
          }
          50% {
            transform: translateX(100%);
            opacity: 1;
          }
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </>
  );
}
