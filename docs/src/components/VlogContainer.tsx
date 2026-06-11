import { useState, useMemo } from 'react';
import vlogsData from '../data/vlogs.json';

interface Vlog {
  videoId: string;
  title: string;
  description: string;
  category: string;
  duration: string;
  publishDate: string;
}

export default function VlogContainer() {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [activeVideo, setActiveVideo] = useState<Vlog | null>(null);

  const categories = useMemo(() => {
    const cats = new Set(vlogsData.map(v => v.category));
    return ['All', ...Array.from(cats)];
  }, []);

  const filteredVlogs = useMemo(() => {
    return selectedCategory === 'All'
      ? vlogsData
      : vlogsData.filter(vlog => vlog.category === selectedCategory);
  }, [selectedCategory]);

  return (
    <div className="vlog-platform">
      {/* Category selector */}
      <section className="vlog-controls" aria-label="Video categories">
        <div className="vlog-categories" role="tablist" aria-label="Video categories">
          {categories.map(cat => (
            <button
              key={cat}
              role="tab"
              aria-selected={selectedCategory === cat}
              onClick={() => setSelectedCategory(cat)}
              className={`vlog-category-btn ${selectedCategory === cat ? 'vlog-category-btn--active' : ''}`}
            >
              {cat}
            </button>
          ))}
        </div>
      </section>

      {/* Video Grid */}
      <section className="vlog-grid-section" aria-label="Video library">
        <div className="vlog-grid">
          {filteredVlogs.map((vlog) => (
            <article
              key={vlog.title}
              className="vlog-card"
              onClick={() => setActiveVideo(vlog)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setActiveVideo(vlog);
                }
              }}
            >
              <div className="vlog-card__content">
                <div className="vlog-card__top">
                  <span className="vlog-card__category">{vlog.category}</span>
                  <span className="vlog-card__duration-badge">{vlog.duration}</span>
                </div>
                <h3 className="vlog-card__title">
                  <span className="vlog-card__play-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </span>
                  <span>{vlog.title}</span>
                </h3>
                <p className="vlog-card__description">{vlog.description}</p>
                <div className="vlog-card__meta">
                  <span className="vlog-card__date">{vlog.publishDate}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Video Modal Player */}
      {activeVideo && (
        <div
          className="vlog-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-heading"
          onClick={() => setActiveVideo(null)}
        >
          <div
            className="vlog-modal__content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="vlog-modal__close"
              onClick={() => setActiveVideo(null)}
              aria-label="Close video player"
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="vlog-modal__player">
              {activeVideo.videoId === 'placeholder' || !activeVideo.videoId ? (
                <div className="vlog-modal__placeholder-player">
                  <div className="vlog-modal__placeholder-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  <h3>Video Walkthrough Coming Soon</h3>
                  <p>Official video content is currently in production. Check back soon for the full guide!</p>
                </div>
              ) : (
                <iframe
                  src={`https://www.youtube.com/embed/${activeVideo.videoId}?autoplay=1`}
                  title={activeVideo.title}
                  frameBorder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="vlog-modal__iframe"
                ></iframe>
              )}
            </div>
            <div className="vlog-modal__info">
              <span className="vlog-card__category">{activeVideo.category}</span>
              <h2 id="modal-heading" className="vlog-modal__title">{activeVideo.title}</h2>
              <p className="vlog-modal__description">{activeVideo.description}</p>
              <div className="vlog-modal__meta">
                <span>Published on {activeVideo.publishDate}</span>
                <span className="vlog-modal__separator">•</span>
                <span>Duration {activeVideo.duration}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
