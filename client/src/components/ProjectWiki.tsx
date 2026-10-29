/**
 * Project Wiki panel — TOC on the left with search, category counts, and new page creation.
 * Rich markdown reader on the right with smart title detection, reading time metrics,
 * copy actions, and a dual-mode Write/Preview editor.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import * as api from '../api';
import Ic, { MOD } from './Icons';
import { renderMarkdown } from '../utils/md';

interface Props {
  projectId: string;
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function parseLog(content: string): { date: string; action: string; summary: string }[] {
  const entries: { date: string; action: string; summary: string }[] = [];
  const regex = /^## \[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*\|\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ date: match[1], action: match[2], summary: match[3] });
  }
  return entries.reverse();
}

const WIKI_ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  book: Ic.book,
  rules: Ic.hash,
  log: Ic.activity,
  doc: Ic.file,
  user: Ic.user,
};

function pickIcon(name: string) {
  if (name === '_index.md') return WIKI_ICONS.book;
  if (name === '_schema.md') return WIKI_ICONS.rules;
  if (name === '_log.md') return WIKI_ICONS.log;
  if (name.startsWith('agents/')) return WIKI_ICONS.user;
  return WIKI_ICONS.doc;
}

const FRIENDLY_NAMES: Record<string, string> = {
  '_index.md': 'Index (Home)',
  '_schema.md': 'Schema & Conventions',
  '_log.md': 'Activity Log',
  'overview.md': 'Overview',
  'architecture.md': 'Architecture',
  'api-endpoints.md': 'API Endpoints',
  'data-model.md': 'Data Model',
  'decisions.md': 'Decisions',
  'progress.md': 'Progress',
};

function formatItemLabel(filename: string): string {
  if (FRIENDLY_NAMES[filename]) return FRIENDLY_NAMES[filename];
  const base = filename.replace(/^(agents|raw)\//, '').replace(/\.md$/, '');
  return base
    .split(/[-_]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function ProjectWiki({ projectId }: Props) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [files, setFiles] = useState<api.SharedContent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTab, setEditTab] = useState<'write' | 'preview'>('write');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newPageName, setNewPageName] = useState('');
  const [logEntries, setLogEntries] = useState<{ date: string; action: string; summary: string }[]>([]);

  const loadFiles = useCallback(async (pickDefault: boolean) => {
    const list = await api.listWikiFiles(projectId);
    setFiles(list);
    if (pickDefault && list.length > 0) {
      const def = list.find(f => f.filename === '_index.md')
        || list.find(f => f.filename === 'overview.md')
        || list[0];
      setSelected(def.filename);
    }
    try {
      const log = await api.getWikiFile(projectId, '_log.md');
      if (log) setLogEntries(parseLog(log.content));
    } catch { /* no log yet */ }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setInitialized(null);
    setFiles([]);
    setSelected(null);
    setContent('');
    setEditing(false);
    setError(null);
    setLogEntries([]);
    api.getWikiStatus(projectId).then(async (s) => {
      if (cancelled) return;
      setInitialized(s.initialized);
      if (s.initialized) await loadFiles(true);
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setInitialized(false);
      }
    });
    return () => { cancelled = true; };
  }, [projectId, loadFiles]);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    setEditing(false);
    setEditTab('write');
    api.getWikiFile(projectId, selected).then(item => {
      if (item) setContent(item.content);
    }).catch(() => setContent(''));
  }, [projectId, selected]);

  const handleInit = async () => {
    try {
      await api.initializeWiki(projectId);
      setInitialized(true);
      await loadFiles(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateWikiFile(projectId, selected, content);
      setEditing(false);
      if (selected === '_log.md') setLogEntries(parseLog(content));
      await loadFiles(false);
    } catch (err) {
      setError('Save failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateNewPage = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newPageName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean) return;
    const filename = clean.endsWith('.md') ? clean : `${clean}.md`;
    try {
      const initialMarkdown = `# ${formatItemLabel(filename)}\n\nDocument details and notes for this section.\n`;
      await api.updateWikiFile(projectId, filename, initialMarkdown);
      setIsCreating(false);
      setNewPageName('');
      await loadFiles(false);
      setSelected(filename);
      setContent(initialMarkdown);
      setEditing(true);
    } catch (err) {
      setError('Failed to create page: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Filtered lists based on search
  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files;
    const q = search.toLowerCase();
    return files.filter(f => f.filename.toLowerCase().includes(q) || formatItemLabel(f.filename).toLowerCase().includes(q));
  }, [files, search]);

  const metaFiles = useMemo(() => filteredFiles.filter(f => f.filename.startsWith('_')), [filteredFiles]);
  const coreFiles = useMemo(() => filteredFiles.filter(f => !f.filename.startsWith('_') && !f.filename.includes('/')), [filteredFiles]);
  const agentFiles = useMemo(() => filteredFiles.filter(f => f.filename.startsWith('agents/')), [filteredFiles]);
  const rawFiles = useMemo(() => filteredFiles.filter(f => f.filename.startsWith('raw/')), [filteredFiles]);

  const selectedFile = selected ? files.find(f => f.filename === selected) : null;

  // Metadata calculations: reading time, word count, clean document title
  const { docTitle, bodyContent, wordCount, readingTime } = useMemo(() => {
    if (!content) return { docTitle: '', bodyContent: '', wordCount: 0, readingTime: 1 };
    const h1Match = content.match(/^#\s+(.+)$/m);
    const title = h1Match ? h1Match[1].trim() : (selected ? formatItemLabel(selected) : '');
    // If the markdown starts with an H1 title, omit it from body to prevent awkward double titles
    const body = h1Match ? content.replace(/^#\s+.+$/m, '').trimStart() : content;
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    const time = Math.max(1, Math.ceil(words / 200));
    return { docTitle: title, bodyContent: body, wordCount: words, readingTime: time };
  }, [content, selected]);

  if (initialized === null) {
    return (
      <div className="panel wiki-panel">
        <div className="panel-empty">Loading Project Wiki…</div>
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="panel wiki-panel">
        <div className="panel-body wiki-init-screen">
          <div className="wiki-init-card">
            <div className="wiki-init-badge">
              <Ic.book size={22} />
            </div>
            <h3>Project Knowledge Base</h3>
            <p>
              Initialize a persistent LLM-aware wiki for this project. Autonomous agents
              maintain architecture diagrams, API specs, decisions, and progress logs automatically.
            </p>
            <button className="batch-btn primary" onClick={handleInit}>
              <Ic.plus size={12} /> Initialize Wiki
            </button>
            {error && <p className="wiki-error-msg">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const renderSection = (title: string, count: number, items: api.SharedContent[]) =>
    items.length === 0 ? null : (
      <div className="wiki-sec-group">
        <div className="wiki-sec-h">
          <span>{title}</span>
          <span className="wiki-sec-count">{count}</span>
        </div>
        {items.map(f => {
          const IconC = pickIcon(f.filename);
          const isSelected = selected === f.filename;
          return (
            <button
              key={f.filename}
              className={'wiki-item' + (isSelected ? ' active' : '')}
              onClick={() => setSelected(f.filename)}
              title={f.filename}
            >
              <div className="ic"><IconC size={13} /></div>
              <div className="ln">{formatItemLabel(f.filename)}</div>
              {f.updatedAt && <div className="tag">{timeAgo(f.updatedAt)}</div>}
            </button>
          );
        })}
      </div>
    );

  return (
    <div className="panel wiki-panel">
      <div className="panel-h wiki-header-bar">
        <div className="panel-h-l">
          <div className="wiki-header-badge">
            <Ic.book size={14} />
          </div>
          <div>
            <h2>Project Wiki</h2>
            <span className="panel-sub">
              Shared Project Memory · {files.length} {files.length === 1 ? 'page' : 'pages'}
            </span>
          </div>
        </div>

        <div className="panel-h-r">
          {error && <span className="wiki-error-msg">{error}</span>}

          {editing ? (
            <div className="wiki-edit-controls">
              <div className="wiki-mode-toggle">
                <button
                  type="button"
                  className={'wiki-mode-btn' + (editTab === 'write' ? ' active' : '')}
                  onClick={() => setEditTab('write')}
                >
                  Write
                </button>
                <button
                  type="button"
                  className={'wiki-mode-btn' + (editTab === 'preview' ? ' active' : '')}
                  onClick={() => setEditTab('preview')}
                >
                  Preview
                </button>
              </div>

              <span className="wiki-kbd-hint">
                <kbd>{MOD}S</kbd> save
              </span>

              <button
                className="chip"
                onClick={() => {
                  setEditing(false);
                  if (selected) {
                    api.getWikiFile(projectId, selected).then(i => {
                      if (i) setContent(i.content);
                    });
                  }
                }}
              >
                Cancel
              </button>

              <button className="chip primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          ) : (
            selected && (
              <div className="wiki-view-controls">
                <button
                  className="chip wiki-action-chip"
                  onClick={handleCopy}
                  title="Copy Raw Markdown"
                >
                  {copied ? <Ic.check size={12} /> : <Ic.copy size={12} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>

                <button
                  className="chip primary wiki-action-chip"
                  onClick={() => setEditing(true)}
                  title="Edit page"
                >
                  <Ic.edit size={12} />
                  <span>Edit</span>
                </button>
              </div>
            )
          )}
        </div>
      </div>

      <div className="wiki-split">
        {/* Left TOC Sidebar */}
        <aside className="wiki-toc scroll">
          {/* Quick Search */}
          <div className="wiki-search-box">
            <Ic.search size={12} />
            <input
              type="text"
              placeholder="Search wiki pages…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="wiki-search-clear"
                onClick={() => setSearch('')}
                title="Clear search"
              >
                <Ic.x size={10} />
              </button>
            )}
          </div>

          {/* New Page Button / Form */}
          {isCreating ? (
            <form className="wiki-create-form" onSubmit={handleCreateNewPage}>
              <input
                type="text"
                autoFocus
                placeholder="page-name (e.g. deployment)"
                value={newPageName}
                onChange={(e) => setNewPageName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsCreating(false);
                    setNewPageName('');
                  }
                }}
              />
              <div className="wiki-create-btns">
                <button type="submit" className="chip primary mini">Create</button>
                <button type="button" className="chip mini" onClick={() => setIsCreating(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="wiki-new-btn"
              onClick={() => setIsCreating(true)}
            >
              <Ic.plus size={12} />
              <span>New Document</span>
            </button>
          )}

          {/* Navigation Sections */}
          {renderSection('Index & Rules', metaFiles.length, metaFiles)}
          {renderSection('Core Architecture', coreFiles.length, coreFiles)}
          {renderSection('Agent Runbooks', agentFiles.length, agentFiles)}
          {renderSection('Raw Knowledge', rawFiles.length, rawFiles)}

          {filteredFiles.length === 0 && (
            <div className="wiki-no-results">
              No documents matching &ldquo;{search}&rdquo;
            </div>
          )}

          {logEntries.length > 0 && (
            <div className="wiki-recent-activity">
              <div className="wiki-sec-h">
                <span>Recent Activity</span>
                <span className="wiki-sec-count">{logEntries.length}</span>
              </div>
              <div className="wiki-log-list">
                {logEntries.slice(0, 6).map((entry, i) => (
                  <div key={i} className="wiki-log-entry">
                    <span className="wiki-log-date">{entry.date}</span>
                    <span className="wiki-log-desc">{entry.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Right Article Pane */}
        <article className="wiki-article scroll">
          {selected && selectedFile ? (
            editing ? (
              <div className="wiki-editor-wrap">
                {editTab === 'write' ? (
                  <textarea
                    className="sp-editor wiki-textarea"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Write markdown here…"
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                        e.preventDefault();
                        handleSave();
                      }
                      if (e.key === 'Escape') {
                        setEditing(false);
                      }
                    }}
                  />
                ) : (
                  <div className="wiki-preview-wrap">
                    <div
                      className="wiki-body"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="wiki-doc-container">
                {/* Clean modern breadcrumb */}
                <div className="wiki-crumb">
                  <span className="crumb-root">Wiki</span>
                  <span className="crumb-sep">/</span>
                  <span className="crumb-folder">
                    {selected.startsWith('_')
                      ? 'Index'
                      : selected.startsWith('agents/')
                      ? 'Agents'
                      : 'Core'}
                  </span>
                  <span className="crumb-sep">/</span>
                  <span className="crumb-file">{selected}</span>
                </div>

                {/* Main Document Title */}
                <h1 className="wiki-title">{docTitle}</h1>

                {/* Metadata & Reading Stats Bar */}
                <div className="wiki-meta-bar">
                  <div className="wiki-meta-left">
                    {selectedFile.updatedAt && (
                      <span className="wiki-meta-item">
                        <span className="wiki-meta-dot" />
                        Last edited {timeAgo(selectedFile.updatedAt)}
                      </span>
                    )}
                    <span className="wiki-meta-sep">&bull;</span>
                    <span className="wiki-meta-item">
                      ~{readingTime} min read
                    </span>
                    <span className="wiki-meta-sep">&bull;</span>
                    <span className="wiki-meta-item">
                      {wordCount} words
                    </span>
                  </div>

                  <div className="wiki-meta-right">
                    <span className="wiki-category-tag">
                      {selected.startsWith('_') ? 'System Schema' : 'Technical Spec'}
                    </span>
                  </div>
                </div>

                {/* Document Body */}
                <div
                  className="wiki-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyContent) }}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.tagName === 'A') {
                      e.preventDefault();
                      const href = target.getAttribute('href') || '';
                      if (href.endsWith('.md') && !href.startsWith('http')) {
                        const currentDir = selected.includes('/') ? selected.split('/').slice(0, -1).join('/') : '';
                        const resolved = currentDir && !href.startsWith('/') ? currentDir + '/' + href : href;
                        const found = files.find(f => f.filename === resolved) || files.find(f => f.filename === href);
                        if (found) setSelected(found.filename);
                      }
                    }
                  }}
                />
              </div>
            )
          ) : (
            <div className="panel-empty wiki-empty-state">
              <div className="wiki-empty-icon">
                <Ic.file size={32} />
              </div>
              <h3>Select a Document</h3>
              <p>Choose a page from the table of contents or create a new one to get started.</p>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
