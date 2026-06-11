import { useState, useMemo, useEffect } from 'react';
import blogsData from '../data/blogs.json';

interface Blog {
  slug: string;
  title: string;
  summary: string;
  content: string;
  category: string;
  author: string;
  publishDate: string;
  readTime: string;
}

export default function BlogContainer() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [activeBlog, setActiveBlog] = useState<Blog | null>(null);

  // Sync state with URL hash for deep linking and back button support
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash) {
        const found = blogsData.find(b => b.slug === hash);
        if (found) {
          setActiveBlog(found);
          return;
        }
      }
      setActiveBlog(null);
    };

    // Initial check
    handleHashChange();

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const categories = useMemo(() => {
    const cats = new Set(blogsData.map(b => b.category));
    return ['All', ...Array.from(cats)];
  }, []);

  const filteredBlogs = useMemo(() => {
    return blogsData.filter(blog => {
      const matchesCategory = selectedCategory === 'All' || blog.category === selectedCategory;
      const matchesSearch = blog.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            blog.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            blog.content.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [searchQuery, selectedCategory]);

  const featuredBlog = useMemo(() => {
    return blogsData[0]; // First blog is featured
  }, []);

  const navigateToBlog = (blog: Blog) => {
    window.location.hash = blog.slug;
  };

  const navigateBack = () => {
    window.location.hash = '';
  };

  // Render full blog post detail view
  if (activeBlog) {
    return (
      <div className="blog-platform">
        <button className="blog-detail__back-btn" onClick={navigateBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          <span>Back to articles</span>
        </button>

        <article className="blog-post">
          <header className="blog-post__header">
            <span className="blog-card__category">{activeBlog.category}</span>
            <h1 className="blog-post__title">{activeBlog.title}</h1>
            
            <div className="blog-card__meta blog-post__meta">
              <span className="blog-card__author">{activeBlog.author}</span>
              <span className="blog-card__separator">•</span>
              <span className="blog-card__date">{activeBlog.publishDate}</span>
              <span className="blog-card__separator">•</span>
              <span className="blog-card__readtime">{activeBlog.readTime}</span>
            </div>
          </header>

          <div className="blog-post__body">
            {activeBlog.content.split('\n\n').map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="blog-platform">
      {/* Featured Marquee Section */}
      {selectedCategory === 'All' && searchQuery === '' && featuredBlog && (
        <section
          className="blog-featured"
          aria-labelledby="featured-heading"
          onClick={() => navigateToBlog(featuredBlog)}
          style={{ cursor: 'pointer' }}
        >
          <div className="blog-featured__badge">Featured Article</div>
          <div className="blog-featured__content">
            <span className="blog-card__category">{featuredBlog.category}</span>
            <h2 id="featured-heading" className="blog-featured__title">{featuredBlog.title}</h2>
            <p className="blog-featured__summary">{featuredBlog.summary}</p>
            <div className="blog-card__meta">
              <span className="blog-card__author">{featuredBlog.author}</span>
              <span className="blog-card__separator">•</span>
              <span className="blog-card__date">{featuredBlog.publishDate}</span>
              <span className="blog-card__separator">•</span>
              <span className="blog-card__readtime">{featuredBlog.readTime}</span>
            </div>
          </div>
        </section>
      )}

      {/* Filter and Search Bar */}
      <section className="blog-controls" aria-label="Blog filters">
        <div className="blog-search-container">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="blog-search-icon" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="blog-search-input"
            aria-label="Search articles"
          />
        </div>

        <div className="blog-categories" role="tablist" aria-label="Blog categories">
          {categories.map(cat => (
            <button
              key={cat}
              role="tab"
              aria-selected={selectedCategory === cat}
              onClick={() => setSelectedCategory(cat)}
              className={`blog-category-btn ${selectedCategory === cat ? 'blog-category-btn--active' : ''}`}
            >
              {cat}
            </button>
          ))}
        </div>
      </section>

      {/* Articles Grid */}
      <section className="blog-grid-section" aria-label="Articles list">
        {filteredBlogs.length > 0 ? (
          <div className="blog-grid">
            {filteredBlogs.map((blog) => (
              <article
                key={blog.slug}
                className="blog-card"
                onClick={() => navigateToBlog(blog)}
                style={{ cursor: 'pointer' }}
              >
                <div className="blog-card__content">
                  <span className="blog-card__category">{blog.category}</span>
                  <h3 className="blog-card__title">{blog.title}</h3>
                  <p className="blog-card__summary">{blog.summary}</p>
                  <div className="blog-card__meta">
                    <span className="blog-card__author">{blog.author}</span>
                    <span className="blog-card__separator">•</span>
                    <span className="blog-card__date">{blog.publishDate}</span>
                    <span className="blog-card__separator">•</span>
                    <span className="blog-card__readtime">{blog.readTime}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="blog-no-results">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" />
            </svg>
            <p>No articles found matching your criteria.</p>
          </div>
        )}
      </section>
    </div>
  );
}
