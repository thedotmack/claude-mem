import { useState, useEffect } from 'react';
import Orb from './Orb';
import ASCIIText from './ASCIIText';

const DUMMY_DATA = {
  title: 'Session Memory Processing',
  subtitle: 'Compressing conversation context into semantic memories',
  memories: [
    {
      id: 1,
      title: 'First Memory',
      subtitle: 'Initial context capture',
      facts: ['Fact 1', 'Fact 2', 'Fact 3'],
      concepts: ['concept1', 'concept2']
    },
    {
      id: 2,
      title: 'Second Memory',
      subtitle: 'Additional context',
      facts: ['Fact A', 'Fact B'],
      concepts: ['concept3']
    },
    {
      id: 3,
      title: 'Third Memory',
      subtitle: 'More context',
      facts: ['Fact X', 'Fact Y', 'Fact Z'],
      concepts: ['concept4', 'concept5', 'concept6']
    }
  ],
  overview: 'This session involved implementing a progressive UI visualization system for memory processing. The user requested a session card component with four distinct states showing the evolution from empty state through memory accumulation to final overview completion.'
};

export default function OverviewCard({
  debugMode = true,
  initialState = 'empty',
  sessionData = null // { overview, memories }
}) {
  const [uiState, setUiState] = useState(initialState);
  const [orbOpacity, setOrbOpacity] = useState(0);
  const [titleOpacity, setTitleOpacity] = useState(0);
  const [asciiFontSize, setAsciiFontSize] = useState(64);
  const [cardOpacity, setCardOpacity] = useState(0);
  const [titlePosition, setTitlePosition] = useState('center'); // 'center' or 'top'
  const [visibleMemories, setVisibleMemories] = useState(0);
  const [overviewOpacity, setOverviewOpacity] = useState(0);
  const [expandedMemoryId, setExpandedMemoryId] = useState(null); // null = show overview, number = show expanded memory
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loadedSessionData, setLoadedSessionData] = useState(null);

  // Use provided sessionData or loaded session data or fallback to dummy data
  const data = sessionData || loadedSessionData || DUMMY_DATA;

  // Orb parameters
  const [orbHue, setOrbHue] = useState(0);
  const [orbHoverIntensity, setOrbHoverIntensity] = useState(0.05);
  const [orbRotateOnHover, setOrbRotateOnHover] = useState(false);
  const [orbForceHoverState, setOrbForceHoverState] = useState(false);

  // Load settings from localStorage or use defaults
  const loadSetting = (key, defaultValue) => {
    const saved = localStorage.getItem(`overviewCard_${key}`);
    return saved !== null ? JSON.parse(saved) : defaultValue;
  };

  // ASCIIText parameters - Title
  const [asciiText, setAsciiText] = useState(() => loadSetting('asciiText', DUMMY_DATA.title));
  const [asciiTitleFontSize, setAsciiTitleFontSize] = useState(() => loadSetting('asciiTitleFontSize', 12));
  const [asciiTitleTextFontSize, setAsciiTitleTextFontSize] = useState(() => loadSetting('asciiTitleTextFontSize', 200));
  const [asciiTitleColor, setAsciiTitleColor] = useState(() => loadSetting('asciiTitleColor', '#60a5fa'));
  const [asciiTitlePlaneHeight, setAsciiTitlePlaneHeight] = useState(() => loadSetting('asciiTitlePlaneHeight', 8));
  const [asciiTitleEnableWaves, setAsciiTitleEnableWaves] = useState(() => loadSetting('asciiTitleEnableWaves', false));
  const [asciiTitleEnableMouseRotation, setAsciiTitleEnableMouseRotation] = useState(() => loadSetting('asciiTitleEnableMouseRotation', false));
  const [asciiTitleOffsetY, setAsciiTitleOffsetY] = useState(() => loadSetting('asciiTitleOffsetY', 0));

  // ASCIIText parameters - Subtitle
  const [asciiSubtitle, setAsciiSubtitle] = useState(() => loadSetting('asciiSubtitle', DUMMY_DATA.subtitle));
  const [asciiSubtitleFontSize, setAsciiSubtitleFontSize] = useState(() => loadSetting('asciiSubtitleFontSize', 6));
  const [asciiSubtitleTextFontSize, setAsciiSubtitleTextFontSize] = useState(() => loadSetting('asciiSubtitleTextFontSize', 120));
  const [asciiSubtitleColor, setAsciiSubtitleColor] = useState(() => loadSetting('asciiSubtitleColor', '#60a5fa'));
  const [asciiSubtitlePlaneHeight, setAsciiSubtitlePlaneHeight] = useState(() => loadSetting('asciiSubtitlePlaneHeight', 4.8));
  const [asciiSubtitleEnableWaves, setAsciiSubtitleEnableWaves] = useState(() => loadSetting('asciiSubtitleEnableWaves', false));
  const [asciiSubtitleEnableMouseRotation, setAsciiSubtitleEnableMouseRotation] = useState(() => loadSetting('asciiSubtitleEnableMouseRotation', false));
  const [asciiSubtitleOffsetY, setAsciiSubtitleOffsetY] = useState(() => loadSetting('asciiSubtitleOffsetY', 0));

  // Debug panel section expansion state
  const [sectionsExpanded, setSectionsExpanded] = useState({
    animation: true,
    orb: false,
    asciiTitle: false,
    asciiSubtitle: false
  });

  // Save to localStorage whenever settings change
  useEffect(() => {
    localStorage.setItem('overviewCard_asciiText', JSON.stringify(asciiText));
  }, [asciiText]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleFontSize', JSON.stringify(asciiTitleFontSize));
  }, [asciiTitleFontSize]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleTextFontSize', JSON.stringify(asciiTitleTextFontSize));
  }, [asciiTitleTextFontSize]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleColor', JSON.stringify(asciiTitleColor));
  }, [asciiTitleColor]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitlePlaneHeight', JSON.stringify(asciiTitlePlaneHeight));
  }, [asciiTitlePlaneHeight]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleEnableWaves', JSON.stringify(asciiTitleEnableWaves));
  }, [asciiTitleEnableWaves]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleEnableMouseRotation', JSON.stringify(asciiTitleEnableMouseRotation));
  }, [asciiTitleEnableMouseRotation]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiTitleOffsetY', JSON.stringify(asciiTitleOffsetY));
  }, [asciiTitleOffsetY]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitle', JSON.stringify(asciiSubtitle));
  }, [asciiSubtitle]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleFontSize', JSON.stringify(asciiSubtitleFontSize));
  }, [asciiSubtitleFontSize]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleTextFontSize', JSON.stringify(asciiSubtitleTextFontSize));
  }, [asciiSubtitleTextFontSize]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleColor', JSON.stringify(asciiSubtitleColor));
  }, [asciiSubtitleColor]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitlePlaneHeight', JSON.stringify(asciiSubtitlePlaneHeight));
  }, [asciiSubtitlePlaneHeight]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleEnableWaves', JSON.stringify(asciiSubtitleEnableWaves));
  }, [asciiSubtitleEnableWaves]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleEnableMouseRotation', JSON.stringify(asciiSubtitleEnableMouseRotation));
  }, [asciiSubtitleEnableMouseRotation]);

  useEffect(() => {
    localStorage.setItem('overviewCard_asciiSubtitleOffsetY', JSON.stringify(asciiSubtitleOffsetY));
  }, [asciiSubtitleOffsetY]);

  // Fetch available sessions
  useEffect(() => {
    if (debugMode) {
      fetch('http://localhost:3001/api/sessions')
        .then(res => res.json())
        .then(data => setSessions(data))
        .catch(err => console.error('Failed to fetch sessions:', err));
    }
  }, [debugMode]);

  // Load session data when selected
  useEffect(() => {
    if (selectedSessionId && debugMode) {
      fetch(`http://localhost:3001/api/session/${selectedSessionId}`)
        .then(res => res.json())
        .then(data => {
          // Transform data to match expected format
          const formattedData = {
            title: data.overview?.content?.split('.')[0] || 'Session Overview',
            subtitle: data.overview?.content?.substring(0, 100) || '',
            overview: data.overview?.content || '',
            memories: data.memories || []
          };
          setLoadedSessionData(formattedData);
          // Auto-transition to complete state to show the data
          if (data.memories?.length > 0) {
            setUiState('complete');
            setVisibleMemories(data.memories.length);
          }
        })
        .catch(err => console.error('Failed to fetch session data:', err));
    }
  }, [selectedSessionId, debugMode]);

  // State transition effects
  useEffect(() => {
    switch (uiState) {
      case 'empty':
        // Reset everything
        setOrbOpacity(0);
        setTitleOpacity(0);
        setAsciiFontSize(64);
        setCardOpacity(0);
        setTitlePosition('center');
        setVisibleMemories(0);
        setOverviewOpacity(0);
        setAsciiText(DUMMY_DATA.title);
        setAsciiSubtitle(DUMMY_DATA.subtitle);

        // Fade in orb and title
        setTimeout(() => setOrbOpacity(1), 100);
        setTimeout(() => {
          setTitleOpacity(1);
          // Start animating font size down
          let size = 64;
          const interval = setInterval(() => {
            size -= 2;
            if (size <= 12) {
              size = 12;
              clearInterval(interval);
            }
            setAsciiFontSize(size);
          }, 30);
        }, 200);
        break;

      case 'first-memory':
        // Card fades in, title moves to top
        setCardOpacity(1);
        setTitlePosition('top');
        setVisibleMemories(1);
        break;

      case 'accumulating':
        // Show all memories
        setVisibleMemories(data.memories?.length || DUMMY_DATA.memories.length);
        break;

      case 'complete':
        // Overview fades in, orb fades out, card becomes solid
        setOverviewOpacity(1);
        setOrbOpacity(0);
        // Make card fully opaque by increasing opacity even more
        setCardOpacity(1);
        break;

      default:
        break;
    }
  }, [uiState]);

  return (
    <div className="relative w-full min-h-screen">
      {/* Debug Controls */}
      {debugMode && (
        <div className="fixed bottom-4 right-4 z-50 bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-xl w-96 max-h-[85vh] flex flex-col">
          {/* Header */}
          <div className="p-4 border-b border-gray-700">
            <h3 className="text-sm font-bold text-blue-400 mb-3">Debug Controls</h3>

            {/* Session Selector */}
            <div className="mb-3">
              <label className="text-xs text-gray-400 mb-1 block">Load Real Session</label>
              <select
                value={selectedSessionId || ''}
                onChange={(e) => setSelectedSessionId(e.target.value || null)}
                className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300"
              >
                <option value="">-- Dummy Data --</option>
                {sessions.map((session) => (
                  <option key={session.session_id} value={session.session_id}>
                    {session.project} - {new Date(session.created_at).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </div>

            {/* State Buttons - 2x2 Grid */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setUiState('empty')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-all ${
                  uiState === 'empty'
                    ? 'bg-blue-500/30 border border-blue-400/60 text-blue-200'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                1. Empty
              </button>
              <button
                onClick={() => setUiState('first-memory')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-all ${
                  uiState === 'first-memory'
                    ? 'bg-blue-500/30 border border-blue-400/60 text-blue-200'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                2. First
              </button>
              <button
                onClick={() => setUiState('accumulating')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-all ${
                  uiState === 'accumulating'
                    ? 'bg-blue-500/30 border border-blue-400/60 text-blue-200'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                3. Accum
              </button>
              <button
                onClick={() => setUiState('complete')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-all ${
                  uiState === 'complete'
                    ? 'bg-blue-500/30 border border-blue-400/60 text-blue-200'
                    : 'bg-gray-800/50 border border-gray-700 text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                4. Complete
              </button>
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="overflow-y-auto flex-1 p-4 space-y-2">

            {/* Animation State Section */}
            <div className="border border-gray-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setSectionsExpanded(s => ({ ...s, animation: !s.animation }))}
                className="w-full px-3 py-2 bg-gray-800/30 hover:bg-gray-800/50 transition-colors flex items-center justify-between text-left"
              >
                <span className="text-xs font-bold text-purple-400">Animation State</span>
                <span className="text-xs text-gray-500">{sectionsExpanded.animation ? '▼' : '▶'}</span>
              </button>
              {sectionsExpanded.animation && (
                <div className="p-3 space-y-2 bg-gray-800/10">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Orb Opacity</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={orbOpacity}
                        onChange={(e) => setOrbOpacity(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{orbOpacity.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Title Opacity</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={titleOpacity}
                        onChange={(e) => setTitleOpacity(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{titleOpacity.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Card Opacity</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={cardOpacity}
                        onChange={(e) => setCardOpacity(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{cardOpacity.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Overview Opacity</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={overviewOpacity}
                        onChange={(e) => setOverviewOpacity(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{overviewOpacity.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Title Position</label>
                    <select
                      value={titlePosition}
                      onChange={(e) => setTitlePosition(e.target.value)}
                      className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300"
                    >
                      <option value="center">Center</option>
                      <option value="top">Top</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Visible Memories</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max={data.memories?.length || 0}
                        step="1"
                        value={visibleMemories}
                        onChange={(e) => setVisibleMemories(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{visibleMemories}/{data.memories?.length || 0}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Orb Parameters Section */}
            <div className="border border-gray-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setSectionsExpanded(s => ({ ...s, orb: !s.orb }))}
                className="w-full px-3 py-2 bg-gray-800/30 hover:bg-gray-800/50 transition-colors flex items-center justify-between text-left"
              >
                <span className="text-xs font-bold text-blue-400">Orb Parameters</span>
                <span className="text-xs text-gray-500">{sectionsExpanded.orb ? '▼' : '▶'}</span>
              </button>
              {sectionsExpanded.orb && (
                <div className="p-3 space-y-2 bg-gray-800/10">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Hue</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        step="1"
                        value={orbHue}
                        onChange={(e) => setOrbHue(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{orbHue}°</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Hover Intensity</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={orbHoverIntensity}
                        onChange={(e) => setOrbHoverIntensity(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{orbHoverIntensity.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={orbRotateOnHover}
                        onChange={(e) => setOrbRotateOnHover(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Rotate On Hover
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={orbForceHoverState}
                        onChange={(e) => setOrbForceHoverState(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Force Hover State
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* ASCII Title Parameters Section */}
            <div className="border border-gray-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setSectionsExpanded(s => ({ ...s, asciiTitle: !s.asciiTitle }))}
                className="w-full px-3 py-2 bg-gray-800/30 hover:bg-gray-800/50 transition-colors flex items-center justify-between text-left"
              >
                <span className="text-xs font-bold text-emerald-400">ASCII Title</span>
                <span className="text-xs text-gray-500">{sectionsExpanded.asciiTitle ? '▼' : '▶'}</span>
              </button>
              {sectionsExpanded.asciiTitle && (
                <div className="p-3 space-y-2 bg-gray-800/10">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Text</label>
                    <textarea
                      value={asciiText}
                      onChange={(e) => setAsciiText(e.target.value)}
                      rows={2}
                      className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 resize-none"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">ASCII Font Size</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="4"
                        max="64"
                        step="1"
                        value={asciiTitleFontSize}
                        onChange={(e) => setAsciiTitleFontSize(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiTitleFontSize}px</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Text Font Size</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="50"
                        max="400"
                        step="10"
                        value={asciiTitleTextFontSize}
                        onChange={(e) => setAsciiTitleTextFontSize(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiTitleTextFontSize}px</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Color</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={asciiTitleColor}
                        onChange={(e) => setAsciiTitleColor(e.target.value)}
                        className="w-8 h-8 rounded border border-gray-700 bg-gray-800 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={asciiTitleColor}
                        onChange={(e) => setAsciiTitleColor(e.target.value)}
                        className="flex-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Plane Height</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="1"
                        max="20"
                        step="0.5"
                        value={asciiTitlePlaneHeight}
                        onChange={(e) => setAsciiTitlePlaneHeight(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiTitlePlaneHeight}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Y Offset</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="-500"
                        max="500"
                        step="10"
                        value={asciiTitleOffsetY}
                        onChange={(e) => setAsciiTitleOffsetY(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiTitleOffsetY}px</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={asciiTitleEnableWaves}
                        onChange={(e) => setAsciiTitleEnableWaves(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Enable Waves
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={asciiTitleEnableMouseRotation}
                        onChange={(e) => setAsciiTitleEnableMouseRotation(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Mouse Rotation
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* ASCII Subtitle Parameters Section */}
            <div className="border border-gray-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setSectionsExpanded(s => ({ ...s, asciiSubtitle: !s.asciiSubtitle }))}
                className="w-full px-3 py-2 bg-gray-800/30 hover:bg-gray-800/50 transition-colors flex items-center justify-between text-left"
              >
                <span className="text-xs font-bold text-amber-400">ASCII Subtitle</span>
                <span className="text-xs text-gray-500">{sectionsExpanded.asciiSubtitle ? '▼' : '▶'}</span>
              </button>
              {sectionsExpanded.asciiSubtitle && (
                <div className="p-3 space-y-2 bg-gray-800/10">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Text</label>
                    <textarea
                      value={asciiSubtitle}
                      onChange={(e) => setAsciiSubtitle(e.target.value)}
                      rows={2}
                      className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 resize-none"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">ASCII Font Size</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="4"
                        max="64"
                        step="1"
                        value={asciiSubtitleFontSize}
                        onChange={(e) => setAsciiSubtitleFontSize(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiSubtitleFontSize}px</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Text Font Size</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="50"
                        max="400"
                        step="10"
                        value={asciiSubtitleTextFontSize}
                        onChange={(e) => setAsciiSubtitleTextFontSize(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiSubtitleTextFontSize}px</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Color</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={asciiSubtitleColor}
                        onChange={(e) => setAsciiSubtitleColor(e.target.value)}
                        className="w-8 h-8 rounded border border-gray-700 bg-gray-800 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={asciiSubtitleColor}
                        onChange={(e) => setAsciiSubtitleColor(e.target.value)}
                        className="flex-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Plane Height</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="1"
                        max="20"
                        step="0.5"
                        value={asciiSubtitlePlaneHeight}
                        onChange={(e) => setAsciiSubtitlePlaneHeight(parseFloat(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiSubtitlePlaneHeight}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Y Offset</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="-500"
                        max="500"
                        step="10"
                        value={asciiSubtitleOffsetY}
                        onChange={(e) => setAsciiSubtitleOffsetY(parseInt(e.target.value))}
                        className="w-32"
                      />
                      <span className="text-xs text-gray-500 w-10 text-right">{asciiSubtitleOffsetY}px</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={asciiSubtitleEnableWaves}
                        onChange={(e) => setAsciiSubtitleEnableWaves(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Enable Waves
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={asciiSubtitleEnableMouseRotation}
                        onChange={(e) => setAsciiSubtitleEnableMouseRotation(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Mouse Rotation
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Orb Background Overlay */}
      <div
        className="fixed inset-0 pointer-events-none transition-opacity duration-500"
        style={{ opacity: orbOpacity }}
      >
        <Orb
          hue={orbHue}
          hoverIntensity={orbHoverIntensity}
          rotateOnHover={orbRotateOnHover}
          forceHoverState={orbForceHoverState}
        />
      </div>

      {/* Floating Title (State 1: Empty) */}
      {titlePosition === 'center' && (
        <div
          className="fixed inset-0 flex items-center justify-center pointer-events-none transition-opacity duration-500"
          style={{ opacity: titleOpacity }}
        >
          <div className="relative w-full flex flex-col items-center">
            <div
              className="relative w-full h-64"
              style={{ transform: `translateY(${asciiTitleOffsetY}px)` }}
            >
              <ASCIIText
                text={asciiText}
                asciiFontSize={asciiTitleFontSize}
                textFontSize={asciiTitleTextFontSize}
                textColor={asciiTitleColor}
                planeBaseHeight={asciiTitlePlaneHeight}
                enableWaves={asciiTitleEnableWaves}
                enableMouseRotation={asciiTitleEnableMouseRotation}
              />
            </div>
            <div
              className="relative w-full h-32"
              style={{ transform: `translateY(${asciiSubtitleOffsetY}px)` }}
            >
              <ASCIIText
                text={asciiSubtitle}
                asciiFontSize={asciiSubtitleFontSize}
                textFontSize={asciiSubtitleTextFontSize}
                textColor={asciiSubtitleColor}
                planeBaseHeight={asciiSubtitlePlaneHeight}
                enableWaves={asciiSubtitleEnableWaves}
                enableMouseRotation={asciiSubtitleEnableMouseRotation}
              />
            </div>
          </div>
        </div>
      )}

      {/* Session Card (States 2-4) */}
      <div
        className="max-w-6xl mx-auto px-4 py-20 transition-opacity duration-500"
        style={{ opacity: cardOpacity }}
      >
        <div className="relative">
          {/* Blur background effect */}
          <div className="absolute -inset-4 bg-gradient-to-r from-blue-600/20 via-purple-600/20 to-emerald-600/20 rounded-3xl blur-2xl" />

          {/* Card with backdrop blur */}
          <div
            className="relative rounded-3xl p-12 border border-gray-800 transition-all duration-500"
            style={{
              backgroundColor: uiState === 'complete'
                ? 'rgba(10, 10, 15, 0.95)'
                : 'rgba(10, 10, 15, 0.7)',
              backdropFilter: 'blur(20px)'
            }}
          >
            {/* Title at top of card (States 2-4) */}
            {titlePosition === 'top' && (
              <div className="mb-8">
                <h1 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-300 via-purple-300 to-emerald-300 mb-4 leading-tight">
                  {data.title || 'Session Overview'}
                </h1>
                <p className="text-xl text-gray-400 leading-relaxed">
                  {data.subtitle || ''}
                </p>
              </div>
            )}

            {/* Overview Section (State 4: Complete) */}
            {uiState === 'complete' && data.overview && (
              <div
                className="mb-8 pb-8 border-b border-gray-800 transition-opacity duration-500"
                style={{ opacity: overviewOpacity }}
              >
                <h3 className="text-sm font-bold text-emerald-400 mb-4 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  SESSION OVERVIEW
                </h3>
                <p className="text-gray-300 leading-relaxed">
                  {data.overview}
                </p>
              </div>
            )}

            {/* Expanded Memory View */}
            {expandedMemoryId !== null && (
              <div>
                {/* Back Button */}
                <button
                  onClick={() => setExpandedMemoryId(null)}
                  className="flex items-center gap-2 mb-6 px-4 py-2 rounded-lg bg-gray-800/50 border border-gray-700 text-gray-300 hover:bg-gray-700/50 hover:border-gray-600 transition-all"
                >
                  <span className="text-lg">←</span>
                  <span className="text-sm font-medium">Back to Overview</span>
                </button>

                {/* Full Memory Card */}
                {(() => {
                  const memory = data.memories?.find(m => m.id === expandedMemoryId);
                  if (!memory) return null;
                  return (
                    <div>
                      <div className="mb-8">
                        <h2 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-purple-300 mb-4">
                          {memory.title}
                        </h2>
                        <p className="text-xl text-gray-400">
                          {memory.subtitle}
                        </p>
                      </div>

                      {memory.facts && memory.facts.length > 0 && (
                        <div className="mb-8">
                          <h3 className="text-sm font-bold text-blue-400 mb-4 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                            FACTS EXTRACTED
                          </h3>
                          <div className="space-y-3">
                            {memory.facts.map((fact, i) => (
                              <div key={i} className="flex gap-3 text-gray-300 leading-relaxed">
                                <span className="text-blue-400 font-mono text-xs mt-1">▸</span>
                                <span>{fact}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {memory.concepts && memory.concepts.length > 0 && (
                        <div>
                          <h3 className="text-sm font-bold text-purple-400 mb-4 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                            CONCEPTS
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            {memory.concepts.map((concept, i) => (
                              <span
                                key={i}
                                className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-400/30 text-purple-300 text-sm font-medium"
                              >
                                {concept}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Memory Mini-cards (Overview) */}
            {expandedMemoryId === null && (
              <div className="grid grid-cols-3 gap-4">
                {(data.memories || []).slice(0, visibleMemories).map((memory, index) => (
                  <div
                    key={memory.id}
                    onClick={() => setExpandedMemoryId(memory.id)}
                    className="border border-gray-700/50 rounded-xl p-4 bg-gray-900/30 cursor-pointer hover:bg-gray-800/40 hover:border-gray-600/50 transition-all"
                    style={{
                      animation: 'fadeInUp 0.5s ease-out',
                      animationDelay: `${index * 0.1}s`,
                      animationFillMode: 'both'
                    }}
                  >
                    <h3 className="text-base font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-purple-300 mb-2">
                      {memory.title}
                    </h3>
                    <p className="text-xs text-gray-400 line-clamp-2 mb-3">
                      {memory.subtitle}
                    </p>

                    {/* Preview badges */}
                    <div className="flex gap-2">
                      {memory.facts && memory.facts.length > 0 && (
                        <span className="px-2 py-0.5 rounded text-xs bg-blue-500/10 border border-blue-400/30 text-blue-300">
                          {memory.facts.length} facts
                        </span>
                      )}
                      {memory.concepts && memory.concepts.length > 0 && (
                        <span className="px-2 py-0.5 rounded text-xs bg-purple-500/10 border border-purple-400/30 text-purple-300">
                          {memory.concepts.length} concepts
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
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
    </div>
  );
}
