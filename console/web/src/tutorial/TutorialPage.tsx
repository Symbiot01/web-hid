import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import './tutorial.css';
import {
  QUICK_CHECKLIST,
  SCREEN_MAP,
  TROUBLESHOOTING_ITEMS,
  TUTORIAL_SECTIONS,
} from './tutorialData.ts';

export function TutorialPage() {
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const normalizedQuery = query.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return TUTORIAL_SECTIONS;
    return TUTORIAL_SECTIONS.map((section) => {
      const sectionMatches =
        section.title.toLowerCase().includes(normalizedQuery) ||
        section.subtitle.toLowerCase().includes(normalizedQuery);
      if (sectionMatches) return section;
      const matchingSteps = section.steps.filter(
        (step) =>
          step.title.toLowerCase().includes(normalizedQuery) ||
          step.summary.toLowerCase().includes(normalizedQuery) ||
          step.bullets.some((bullet) => bullet.toLowerCase().includes(normalizedQuery)) ||
          (step.tip && step.tip.toLowerCase().includes(normalizedQuery)),
      );
      return { ...section, steps: matchingSteps };
    }).filter((section) => section.steps.length > 0);
  }, [normalizedQuery]);

  const filteredTroubleshooting = useMemo(() => {
    if (!normalizedQuery) return TROUBLESHOOTING_ITEMS;
    return TROUBLESHOOTING_ITEMS.filter(
      (item) =>
        item.symptom.toLowerCase().includes(normalizedQuery) ||
        item.where.toLowerCase().includes(normalizedQuery) ||
        item.cause.toLowerCase().includes(normalizedQuery) ||
        item.fix.some((line) => line.toLowerCase().includes(normalizedQuery)),
    );
  }, [normalizedQuery]);

  const completedCount = Object.values(checked).filter(Boolean).length;

  function toggleCheck(index: number) {
    setChecked((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  return (
    <div className="tut-page">
      <header className="tut-topbar">
        <div className="tut-brand">
          <span className="tut-brand-title">Operator Console · Complete Tutorial</span>
          <span className="tut-badge tut-badge-ok">No Password or Live Bridge Required</span>
        </div>
        <div className="tut-top-actions">
          <Link to="/" className="btn ghost tut-link-btn">
            Sign-In Page
          </Link>
          <Link to="/app" className="btn primary tut-link-btn">
            Open IDE
          </Link>
        </div>
      </header>

      <div className="tut-layout">
        <aside className="tut-sidebar" aria-label="Tutorial navigation">
          <p className="tut-sidebar-label">Search Guide</p>
          <input
            type="search"
            className="tut-search"
            placeholder="Filter (e.g. hotspot, WPM, snap)…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter tutorial sections"
          />
          <p className="tut-sidebar-label">Contents</p>
          <nav className="tut-nav">
            <a href="#screen-map" className="tut-nav-link">
              <span className="tut-nav-step">00</span>
              <span>Screen Layout Map</span>
            </a>
            {TUTORIAL_SECTIONS.map((section, idx) => (
              <a key={section.id} href={`#${section.id}`} className="tut-nav-link">
                <span className="tut-nav-step">0{idx + 1}</span>
                <span>{section.title.split('(')[0].trim()}</span>
              </a>
            ))}
            <a href="#troubleshooting" className="tut-nav-link">
              <span className="tut-nav-step">05</span>
              <span>Troubleshooting</span>
            </a>
          </nav>
        </aside>

        <main className="tut-main">
          <section className="tut-hero" aria-label="Overview and quick start checklist">
            <span className="tut-badge">Beginner-Friendly Walkthrough</span>
            <h1>How to Use the Remote Operator Console</h1>
            <p>
              This guide walks through every part of the Operator Console step by step: connecting the LookCam camera
              over your Android phone hotspot, snapping problems into the AI Coding Agent, compiling and testing C++17
              code, and typing solutions onto the remote machine through the ESP32-S3 USB HID keyboard. You can read and
              use this page anytime without logging in or connecting hardware.
            </p>

            <div className="tut-checklist">
              <div className="tut-checklist-head">
                <strong>Interactive Session Checklist ({completedCount}/{QUICK_CHECKLIST.length} done)</strong>
                {completedCount > 0 ? (
                  <button
                    type="button"
                    className="btn ghost ide-mini"
                    onClick={() => setChecked({})}
                  >
                    Reset checklist
                  </button>
                ) : null}
              </div>
              <ol className="tut-check-items">
                {QUICK_CHECKLIST.map((item, idx) => {
                  const isDone = Boolean(checked[idx]);
                  return (
                    <li key={item}>
                      <label className={`tut-check-item${isDone ? ' done' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isDone}
                          onChange={() => toggleCheck(idx)}
                        />
                        <span>
                          <strong>Step {idx + 1}:</strong> {item}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>

          <section id="screen-map" className="tut-section" aria-label="System Overview and Screen Map">
            <div className="tut-section-head">
              <span className="tut-badge">Overview</span>
              <h2>Console Screen Map (4-Panel Workspace)</h2>
              <p>
                Once signed in at <code>/app</code>, the IDE is divided into 4 resizable panels. Drag the dividers
                between any panels to adjust their size.
              </p>
            </div>
            <div className="tut-map-grid">
              {SCREEN_MAP.map((quad) => (
                <article key={quad.id} className="tut-quad">
                  <div className="tut-quad-top">
                    <span className="tut-quad-pos">{quad.position}</span>
                    <div className="tut-quad-tabs">
                      {quad.tabs.map((tab) => (
                        <span key={tab} className="tut-mini-tab">
                          {tab}
                        </span>
                      ))}
                    </div>
                  </div>
                  <h3>{quad.title}</h3>
                  <p>{quad.summary}</p>
                  <ul className="tut-bullets">
                    {quad.highlights.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>

          {filteredSections.map((section) => (
            <section key={section.id} id={section.id} className="tut-section" aria-label={section.title}>
              <div className="tut-section-head">
                <span className="tut-badge">{section.badge}</span>
                <h2>{section.title}</h2>
                <p>{section.subtitle}</p>
              </div>

              {section.pills && section.pills.length > 0 ? (
                <div className="tut-pills-box">
                  <span className="tut-pills-title">What the Status Pills Mean</span>
                  <div className="tut-pills-list">
                    {section.pills.map((pill) => (
                      <div key={pill.label} className="tut-pill-item">
                        <div>
                          <span className={`ide-hid-pill${pill.tone === 'ok' ? ' ok' : ''}`}>{pill.label}</span>
                        </div>
                        <span className="tut-pill-desc">{pill.meaning}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="tut-steps">
                {section.steps.map((step) => (
                  <article key={step.title} className="tut-step-card">
                    <h3>{step.title}</h3>
                    <p className="tut-step-summary">{step.summary}</p>
                    <ul className="tut-bullets">
                      {step.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                    {step.code ? <pre className="tut-code">{step.code}</pre> : null}
                    {step.tip ? (
                      <p className="tut-tip">
                        <strong>Tip:</strong> {step.tip}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))}

          <section id="troubleshooting" className="tut-section" aria-label="Troubleshooting Quick Reference">
            <div className="tut-section-head">
              <span className="tut-badge">Reference</span>
              <h2>Troubleshooting & Common Fixes</h2>
              <p>If something does not connect or type as expected, match what you see below for an immediate fix.</p>
            </div>
            <div className="tut-trouble-grid">
              {filteredTroubleshooting.map((item) => (
                <article key={item.symptom} className="tut-trouble-card">
                  <span className="tut-quad-pos">{item.where}</span>
                  <h3>{item.symptom}</h3>
                  <p className="tut-trouble-cause">{item.cause}</p>
                  <ul className="tut-bullets">
                    {item.fix.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
